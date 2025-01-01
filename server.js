const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const WebSocket = require('ws');
const FormData = require('form-data');

const app = express();
const httpPort = 3005;
const wsPort = 3001;  // WebSocket 使用不同的端口

// 设置网站图标
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'image', 'AUTO.ico'));
});

// 增加请求大小限制
app.use(bodyParser.json({limit: '50mb'}));
app.use(bodyParser.urlencoded({
    limit: '50mb',
    extended: true,
    parameterLimit: 50000
}));

// 配置静态文件服务
app.use(express.static(path.join(__dirname, 'public')));
app.use('/image', express.static(path.join(__dirname, 'public', 'image')));

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ port: wsPort });

// 存储所有连接的客户端
const clients = new Set();

// 存储最新的图像数据
let latestImageData = null;
let latestPrompt = '';

// 添加新的WebSocket连接来监听ComfyUI的状态
let comfyWs = null;

// 在文件开头添加配置文件读取
let comfyuiPath;
try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        comfyuiPath = config.comfyuiPath;
        // 如果配置文件中有路径，立即设置为环境变量
        if (comfyuiPath) {
            process.env.COMFYUI_DIR = comfyuiPath;
            console.log('已从配置文件加载 ComfyUI 路径:', comfyuiPath);
        }
    }
} catch (error) {
    console.error('读取配置文件失败:', error);
}

// 获取 ComfyUI 路径的辅助函数
function getComfyUIPath() {
    // 优先使用配置文件中的路径
    if (comfyuiPath && fs.existsSync(comfyuiPath)) {
        return comfyuiPath;
    }
    // 其次使用环境变量
    if (process.env.COMFYUI_DIR && fs.existsSync(process.env.COMFYUI_DIR)) {
        return process.env.COMFYUI_DIR;
    }
    // 最使用默认路径
    const defaultPath = path.join(__dirname, '..', 'ComfyUI');
    console.log('使用默认 ComfyUI 路径:', defaultPath);
    return defaultPath;
}

function connectComfyWebSocket() {
    comfyWs = new WebSocket('ws://127.0.0.1:8188/ws');
    
    comfyWs.on('open', () => {
        console.log('已连接到ComfyUI WebSocket');
        // 广播连接成功消息
        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'connection', status: 'connected' }));
            }
        });
    });

    comfyWs.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log('收到ComfyUI消息:', message);
            
            // 转发相关消息到所有客户端
            clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(message));
                }
            });
        } catch (e) {
            console.error('处理ComfyUI消息错误:', e);
        }
    });

    comfyWs.on('close', () => {
        console.log('ComfyUI WebSocket连接已关闭，尝试重新连接...');
        // 广播断开连接消息
        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'connection', status: 'disconnected' }));
            }
        });
        setTimeout(connectComfyWebSocket, 5000);
    });
}

// 启动时连接到ComfyUI WebSocket
connectComfyWebSocket();

// 在文件开头的常量定义部分添加
const MAX_SAVED_IMAGES = 20;  // 最大保留图片数量

// 添加清理图片的函数
function cleanupSavedImages() {
    try {
        const savedImagesDir = path.join(__dirname, 'public', 'saved_images');
        if (!fs.existsSync(savedImagesDir)) {
            return;
        }

        const files = fs.readdirSync(savedImagesDir)
            .filter(file => file.endsWith('.png'))
            .map(file => ({
                name: file,
                path: path.join(savedImagesDir, file),
                time: fs.statSync(path.join(savedImagesDir, file)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);  // 按时间降序排序

        // 如果图片数量超过限制，删除旧图片
        if (files.length > MAX_SAVED_IMAGES) {
            files.slice(MAX_SAVED_IMAGES).forEach(file => {
                try {
                    fs.unlinkSync(file.path);
                    console.log(`已删除旧图片: ${file.name}`);
                } catch (err) {
                    console.error(`删除图片失败 ${file.name}:`, err);
                }
            });
        }
    } catch (error) {
        console.error('清理saved_images目录失败:', error);
    }
}

// 修改 saveReceivedImage 函数，在保存新图片后调用清理函数
const saveReceivedImage = async (base64Data, prompt) => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `generated_${timestamp}.png`;
        const savePath = path.join(__dirname, 'public', 'saved_images', fileName);
        
        // 确保保存目录存在
        const saveDir = path.join(__dirname, 'public', 'saved_images');
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
        }
        
        // 保存图片
        fs.writeFileSync(savePath, base64Data, 'base64');
        
        // 清理旧图片
        cleanupSavedImages();
        
        return fileName;
    } catch (error) {
        console.error('保存图片失败:', error);
        return null;
    }
};

// 修改 WebSocket 消息处理
wss.on('connection', (ws) => {
    console.log('新的WebSocket连接');
    clients.add(ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('收到WebSocket消息:', data);
            if (data.type === 'image') {
                // 保存接收到的图片
                const fileName = await saveReceivedImage(data.image, data.prompt);
                if (fileName) {
                    data.savedPath = `/saved_images/${fileName}`;
                }
                
                latestImageData = data.image;
                latestPrompt = data.prompt;
                
                // 广播给其他客户端
                clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'image',
                            image: data.image,
                            prompt: data.prompt,
                            savedPath: data.savedPath,
                            timestamp: Date.now()
                        }));
                    }
                });
            }
        } catch (e) {
            console.error('消息处理错误:', e);
        }
    });

    // 监听ComfyUI的WebSocket消息
    comfyWs.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log('收到ComfyUI消息:', message);
            
            // 如果是执行完成的消息
            if (message.type === 'executed' && message.data?.output) {
                // 试获取最新的图片
                setTimeout(() => {
                    ws.send(JSON.stringify({
                        type: 'refresh',
                        timestamp: Date.now()
                    }));
                }, 1000); // 延迟1秒等待图片保存
            }
        } catch (e) {
            console.error('处理ComfyUI消息错误:', e);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log('WebSocket连接已关闭');
    });
});

// 广播图片给所有连接的客户端
function broadcastImage(imageData, prompt) {
    console.log('广播图片数据:', imageData ? '有图片数据' : '无图片数据');
    const message = JSON.stringify({
        type: 'image',
        image: imageData,
        prompt: prompt,
        timestamp: Date.now()
    });

    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// 修改上传路由
app.post('/api/comfyui/upload/:connection_id', async (req, res) => {
    try {
        if (!req.body || !req.body.image) {
            return res.status(400).json({ error: 'No image data provided' });
        }

        const connectionId = req.params.connection_id;
        const nodeId = req.body.nodeId;  // 添加节点ID
        
        try {
            // 将 base64 转换为文件
            const base64Data = req.body.image.split(',')[1];
            const tempFilePath = path.join(__dirname, 'temp', `${connectionId}.png`);
            
            // 确保临时目录存在
            if (!fs.existsSync(path.join(__dirname, 'temp'))) {
                fs.mkdirSync(path.join(__dirname, 'temp'));
            }
            
            // 写入临时文件
            fs.writeFileSync(tempFilePath, base64Data, 'base64');
            
            // 创建 FormData
            const form = new FormData();
            form.append('image', fs.createReadStream(tempFilePath));
            
            // 上传到 ComfyUI
            let imagePath;
            try {
                const response = await axios.post('http://127.0.0.1:8188/upload/image', form, {
                    headers: {
                        ...form.getHeaders()
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                });
                imagePath = response.data.name;
            } catch (uploadError) {
                console.error('ComfyUI上传失败:', uploadError);
                throw new Error('ComfyUI上传失败');
            }

            // 删除临时文件
            fs.unlinkSync(tempFilePath);

            // 获取上传后的文件路径
            console.log('Image uploaded:', imagePath);

            // 广播图片给所有客户端
            broadcastImage(base64Data, '');

            res.json({
                success: true,
                connection_id: connectionId,
                image_path: imagePath,
                preview: req.body.image  // 返回原始base64数据作为预览
            });
        } catch (error) {
            console.error('Upload failed:', error.message);
            // 确保删除临时文件
            const tempFilePath = path.join(__dirname, 'temp', `${connectionId}.png`);
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
            res.status(500).json({
                error: '上传失败',
                details: error.response?.data || error.message
            });
        }
    } catch (error) {
        console.error('Request processing failed:', error);
        res.status(500).json({
            error: '请求处理失败',
            details: error.message
        });
    }
});

// 添加保存原始图片的路由
app.post('/api/save-original-image', (req, res) => {
    try {
        const { nodeId, imageData } = req.body;
        const base64Data = imageData.split(',')[1];
        const originalImagesDir = path.join(__dirname, 'public', 'original_images');
        
        // 确保目录存在
        if (!fs.existsSync(originalImagesDir)) {
            fs.mkdirSync(originalImagesDir, { recursive: true });
        }
        
        // 保存原始图片
        const filePath = path.join(originalImagesDir, `${nodeId}_original.png`);
        fs.writeFileSync(filePath, base64Data, 'base64');
        
        res.json({ success: true });
    } catch (error) {
        console.error('保存原始图片失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 添加获取原始图片的路由
app.get('/api/get-original-image/:nodeId', (req, res) => {
    try {
        const { nodeId } = req.params;
        const filePath = path.join(__dirname, 'public', 'original_images', `${nodeId}_original.png`);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '原始图片不存在' });
        }
        
        const imageData = fs.readFileSync(filePath, 'base64');
        res.json({ image: `data:image/png;base64,${imageData}` });
    } catch (error) {
        console.error('获取原始图片失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取工作流列表
app.get('/api/workflows', (req, res) => {
    try {
        const workflowDir = path.join(__dirname, 'workflow');
        // 确保目录存在
        if (!fs.existsSync(workflowDir)) {
            fs.mkdirSync(workflowDir);
        }
        const files = fs.readdirSync(workflowDir)
            .filter(file => file.endsWith('.json'))
            .map(file => ({
                name: file.replace('.json', ''),
                path: file
            }));
        res.json(files);
    } catch (error) {
        console.error('获取工作流列表失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取指定工作流
app.get('/api/workflow/:filename?', (req, res) => {
    try {
        const filename = req.params.filename || 'image.json';
        const filePath = path.join(__dirname, 'workflow', filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '工作文件不存在' });
        }

        const workflow = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        // 修改转换函数，保持完整的参数名
        const convertParamNames = (nodes) => {
            for (const nodeId in nodes) {
                const node = nodes[nodeId];
                if (node.inputs) {
                    // 保持原始inputs对象
                    const originalInputs = { ...node.inputs };
                    
                    // 为每个参数添加显示名称
                    for (const key in originalInputs) {
                        if (typeof originalInputs[key] === 'object' && originalInputs[key] !== null) {
                            originalInputs[key].displayName = key; // 添加显示名称
                        }
                    }
                    
                    node.inputs = originalInputs;
                }
            }
            return nodes;
        };

        // 转换参数名
        if (workflow.nodes) {
            workflow.nodes = convertParamNames(workflow.nodes);
        }

        res.json(workflow);
    } catch (error) {
        console.error('读取工作流失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 更新工作流
app.post('/api/workflow/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(__dirname, 'workflow', filename);
        fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (error) {
        console.error('更新工作流失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 执行工作流
app.post('/api/execute', async (req, res) => {
    try {
        const workflow = req.body;
        // 发送到 ComfyUI API
        const response = await axios.post('http://127.0.0.1:8188/prompt', {
            // 需要按照 ComfyUI API 的格式构造请求
            prompt: workflow,
            // 添加客户端 ID
            client_id: "comfyui-web"
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // 返回执行结果
        res.json(response.data);
    } catch (error) {
        console.error('执行工作流失败:', error);
        res.status(500).json({ 
            error: error.message,
            details: '检查comfyui是否启动，工作流是否能正常执行'
        });
    }
});

// 添加新的路由来处理预设
app.get('/api/preset/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const presetPath = path.join(__dirname, 'preset', `${filename}.preset.json`);
        
        if (!fs.existsSync(presetPath)) {
            return res.json({ selectedParams: {} }); // 果预设不存在，返回空对象
        }

        const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
        res.json(preset);
    } catch (error) {
        console.error('读取预设失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 保存预设
app.post('/api/preset/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const presetPath = path.join(__dirname, 'preset', `${filename}.preset.json`);
        fs.writeFileSync(presetPath, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (error) {
        console.error('保存预设失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 修改输出目录路径的获取方式
app.get('/api/output-images', (req, res) => {
    try {
        // 用环境变量或配置文件来设置ComfyUI的路径
        const comfyuiDir = getComfyUIPath();
        const outputDir = path.join(comfyuiDir, 'output');
        
        if (!fs.existsSync(outputDir)) {
            return res.status(404).json({ error: '输出目录不存在' });
        }

        const files = fs.readdirSync(outputDir)
            .filter(file => file.endsWith('.png') || file.endsWith('.jpg'))
            .map(file => ({
                name: file,
                path: `/outputs/${file}`,
                time: fs.statSync(path.join(outputDir, file)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        res.json(files);
    } catch (error) {
        console.error('获取输出图片失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 修改静态文件服务器的路径
app.use('/outputs', express.static(path.join(getComfyUIPath(), 'output')));

// 添加获取保存图片列表的路由
app.get('/api/saved-images', (req, res) => {
    try {
        const savedImagesDir = path.join(__dirname, 'public', 'saved_images');
        if (!fs.existsSync(savedImagesDir)) {
            return res.json([]);
        }
        
        const files = fs.readdirSync(savedImagesDir)
            .filter(file => file.endsWith('.png'))
            .map(file => ({
                name: file,
                path: `/saved_images/${file}`,
                time: fs.statSync(path.join(savedImagesDir, file)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);  // 按时间降序排序
            
        res.json(files);
    } catch (error) {
        console.error('获取保存图片列表失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 添加静态文件服务
app.use('/saved_images', express.static(path.join(__dirname, 'public', 'saved_images')));

// 在现有的路由之前添加新的路由
app.get('/api/models', (req, res) => {
    try {
        // 使用环境变量或默认路径
        const comfyuiDir = getComfyUIPath();
        const modelsDir = path.join(comfyuiDir, 'models');
        
        // 需要扫描的子目录
        const subDirs = [
            'checkpoints',
            'controlnet',
            'loras',
            'unet'
        ];
        
        const models = {};
        
        // 扫描每个子目录
        subDirs.forEach(dir => {
            const fullPath = path.join(modelsDir, dir);
            if (fs.existsSync(fullPath)) {
                // 获取支持的文件扩展名
                const supportedExt = [
                    '.ckpt',
                    '.safetensors',
                    '.pt',
                    '.pth',
                    '.bin',
                    '.onnx',
                    '.sft',
                    '.gguf'
                ];
                
                // 递归读取目录下的所有文件
                const files = [];
                function scanDir(dirPath) {
                    const items = fs.readdirSync(dirPath);
                    items.forEach(item => {
                        const fullPath = path.join(dirPath, item);
                        const stat = fs.statSync(fullPath);
                        if (stat.isDirectory()) {
                            scanDir(fullPath);
                        } else if (supportedExt.some(ext => item.toLowerCase().endsWith(ext))) {
                            // 取相对于模型目录的路径
                            const relativePath = path.relative(modelsDir, fullPath);
                            files.push({
                                name: item,
                                path: relativePath,
                                size: (stat.size / (1024 * 1024)).toFixed(2) + ' MB', // 转换为MB
                                lastModified: stat.mtime
                            });
                        }
                    });
                }
                
                try {
                    scanDir(fullPath);
                    models[dir] = files;
                } catch (error) {
                    console.error(`扫描 ${dir} 目录失败:`, error);
                    models[dir] = { error: error.message };
                }
            } else {
                models[dir] = { error: '目录不存在' };
            }
        });
        
        res.json({
            comfyuiPath: comfyuiDir,
            models: models
        });
    } catch (error) {
        console.error('获取模型列表失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 添加设置检查路由
app.get('/api/settings', (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        let settings = {};
        
        if (fs.existsSync(configPath)) {
            settings = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        
        // 检查 ComfyUI 路径是否有效
        if (settings.comfyuiPath) {
            const isValid = fs.existsSync(path.join(settings.comfyuiPath, 'main.py'));
            if (!isValid) {
                settings.comfyuiPath = '';
            }
        }
        
        res.json(settings);
    } catch (error) {
        console.error('读取设置失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 修改设置保存路由
app.post('/api/settings', async (req, res) => {
    try {
        const { comfyuiPath } = req.body;
        
        // 验证路径是否有效
        if (!fs.existsSync(path.join(comfyuiPath, 'main.py'))) {
            return res.status(400).json({ error: '无效的 ComfyUI 路径' });
        }
        
        // 保存设置
        const configPath = path.join(__dirname, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({ comfyuiPath }, null, 2));
        
        // 更新全局变量
        process.env.COMFYUI_DIR = comfyuiPath;
        
        // 广播设置更新消息
        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ 
                    type: 'settings_updated',
                    settings: { comfyuiPath } 
                }));
            }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('保存设置失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 修改 printModelsInfo 函数
function printModelsInfo(comfyuiDir) {
    try {
        const modelsDir = path.join(comfyuiDir, 'models');
        
        // 获取所有模型目录
        const modelDirs = fs.readdirSync(modelsDir)
            .filter(item => fs.statSync(path.join(modelsDir, item)).isDirectory());
        
        console.log('\n=== ComfyUI 模型信息 ===');
        console.log('ComfyUI路径:', comfyuiDir);
        console.log('模型根目录:', modelsDir);
        console.log('发现模型目录:', modelDirs);
        
        // 记录未找到的文件类型
        const notFoundExtensions = new Set();
        
        // 遍历所有模型目录
        modelDirs.forEach(dir => {
            const fullPath = path.join(modelsDir, dir);
            if (fs.existsSync(fullPath)) {
                // 获取支持的文件扩展名
                const supportedExt = [
                    '.ckpt',
                    '.safetensors',
                    '.pt',
                    '.pth',
                    '.bin',
                    '.onnx',
                    '.sft',
                    '.gguf'
                ];
                const files = [];
                
                function scanDir(dirPath) {
                    const items = fs.readdirSync(dirPath);
                    items.forEach(item => {
                        const fullPath = path.join(dirPath, item);
                        const stat = fs.statSync(fullPath);
                        if (stat.isDirectory()) {
                            console.log(`  发现子目录: ${path.relative(modelsDir, fullPath)}`);
                            scanDir(fullPath);
                        } else {
                            const ext = path.extname(item).toLowerCase();
                            if (supportedExt.includes(ext)) {
                                const size = (stat.size / (1024 * 1024)).toFixed(2);
                                files.push({
                                    name: item,
                                    path: path.relative(modelsDir, fullPath),
                                    size: `${size} MB`
                                });
                            } else if (ext) {
                                notFoundExtensions.add(ext);
                            }
                        }
                    });
                }
                
                try {
                    scanDir(fullPath);
                    console.log(`\n${dir}目录 (${files.length}个文件):`);
                    files.forEach(file => {
                        console.log(`  - ${file.path} (${file.size})`);
                    });
                } catch (error) {
                    console.error(`扫描 ${dir} 目录失败:`, error);
                }
            } else {
                console.log(`\n${dir}目录: 不存在`);
            }
        });
        
        console.log('\n总计:');
        console.log(`- 模型目录数: ${modelDirs.length}`);
        console.log(`- 支持的文件类型: ${supportedExt.join(', ')}`);
        if (notFoundExtensions.size > 0) {
            console.log('- 未被识别的文件类型:', Array.from(notFoundExtensions).join(', '));
        }
        console.log('\n===================\n');
    } catch (error) {
        console.error('扫描模型目录失败:', error);
    }
}

// 添加获取 checkpoints 列表的路由
app.get('/api/checkpoints', (req, res) => {
    try {
        const comfyuiDir = getComfyUIPath();
        const checkpointsDir = path.join(comfyuiDir, 'models', 'checkpoints');
        
        if (!fs.existsSync(checkpointsDir)) {
            return res.json([]);
        }
        
        const supportedExt = [
            '.safetensors',
            '.ckpt',
            '.pt',
            '.pth',
            '.bin',
            '.onnx',
            '.sft',
            '.gguf'
        ];
        
        const files = fs.readdirSync(checkpointsDir)
            .filter(file => supportedExt.some(ext => file.toLowerCase().endsWith(ext)))
            .map(file => ({
                name: file,
                value: file
            }));
        
        res.json(files);
    } catch (error) {
        console.error('获取 checkpoints 列表失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 添加重命名工作流的路由
app.post('/api/workflow/rename', (req, res) => {
    try {
        const { oldPath, newPath } = req.body;
        const oldFilePath = path.join(__dirname, 'workflow', oldPath);
        const newFilePath = path.join(__dirname, 'workflow', newPath);
        
        // 检查源文件是否存在
        if (!fs.existsSync(oldFilePath)) {
            return res.status(404).json({ error: '源文件不存在' });
        }
        
        // 检查目标文件是否已存在
        if (fs.existsSync(newFilePath)) {
            return res.status(400).json({ error: '目标文件已存在' });
        }
        
        // 重命名文件
        fs.renameSync(oldFilePath, newFilePath);
        
        res.json({ success: true });
    } catch (error) {
        console.error('重命名工作流失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 修改获取不同类型模型列表的路由
app.get('/api/models/:type', (req, res) => {
    try {
        const { type } = req.params;
        const comfyuiDir = getComfyUIPath();
        const modelsDir = path.join(comfyuiDir, 'models');
        
        // 如果请求的是目录列表
        if (type === 'directories') {
            // 获取 models 目录下的所有目录
            const directories = fs.readdirSync(modelsDir)
                .filter(item => fs.statSync(path.join(modelsDir, item)).isDirectory())
                .map(dir => ({
                    name: dir,
                    path: dir
                }));
            return res.json(directories);
        }
        
        const modelDir = path.join(modelsDir, type);
        
        if (!fs.existsSync(modelDir)) {
            return res.json([]);
        }
        
        // 支持所有常见的模型文件扩展名
        const supportedExt = [
            '.safetensors',
            '.ckpt',
            '.pt',
            '.pth',
            '.bin',
            '.onnx',
            '.sft',
            '.gguf'
        ];
        
        const files = fs.readdirSync(modelDir)
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return supportedExt.includes(ext);
            })
            .map(file => ({
                name: file,
                value: file
            }));
        
        res.json(files);
    } catch (error) {
        console.error(`获取 ${req.params.type} 列表失败:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 添加新的路由来获取预处理器列表
app.get('/api/preprocessors', (req, res) => {
    try {
        // 预定义处理器列表
        const preprocessors = [
            'AnimeFace_SemSegPreprocessor',
            'AnyLineArtPreprocessor_aux',
            'BinaryPreprocessor',
            'CannyEdgePreprocessor',
            'ColorPreprocessor',
            'DensePreprocessor',
            'DepthAnythingPreprocessor',
            'Zoe_DepthAnythingPreprocessor',
            'DepthAnythingV2Preprocessor',
            'DSTNE-NormalMapPreprocessor',
            'DWPreprocessor',
            'AnimalPosePreprocessor',
            'HEDPreprocessor',
            'FakeScribblePreprocessor',
            'LeReS-DepthMapPreprocessor',
            'LineArtPreprocessor',
            'AnimeLineArtPreprocessor',
            'LinenartStandardPreprocessor',
            'Manga2Anime_LineArt_Preprocessor',
            'MediaPipe-FaceMeshPreprocessor',
            'MeshGraphormer-DepthMapPreprocessor',
            'Metric3D-DepthMapPreprocessor',
            'Metric3D-NormalMapPreprocessor',
            'MiDaS-NormalMapPreprocessor',
            'MiDaS-DepthMapPreprocessor',
            'M-LSDPreprocessor',
            'BAE-NormalMapPreprocessor',
            'OneFormer-COCO-SemSegPreprocessor',
            'OneFormer-ADE20K-SemSegPreprocessor',
            'OpenposePreprocessor',
            'PiDiNetPreprocessor',
            'PyraCannyPreprocessor',
            'ImageLuminanceDetector',
            'ImageInpaintPreprocessor',
            'ScribblePreprocessor',
            'Scribble_XDoG_Preprocessor',
            'Scribble_HED_Preprocessor',
            'SAMPreprocessor',
            'ShufflePreprocessor',
            'TEEDPreprocessor',
            'TilePreprocessor',
            'TTPlanet_TileGF_Preprocessor',
            'TTPlanet_TileSimple_Preprocessor',
            'UniFormer_SemSegPreprocessor',
            'ZoeDepthPreprocessor',
            'Zoe-DepthMapPreprocessor'
        ];
        
        res.json(preprocessors);
    } catch (error) {
        console.error('获取预处理器列表失败:', error);
        res.status(500).json({ error: '获取预处理器列表失败' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/autocmfy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/autocmfy.html'));
});

// 添加全局错误处理中间件
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(500).json({
        error: '服务器错误',
        details: err.message
    });
});

// 修改 Express 服务器启动错误处理
const startServer = (port) => {
    try {
        return app.listen(port, () => {
            console.log(`HTTP server running at http://localhost:${port}`);
        });
    } catch (error) {
        console.error('启动服务器失败:', error);
        // 通知主进程发生错误
        if (process.send) {
            process.send({
                type: 'error',
                error: error.message
            });
        }
        process.exit(1);
    }
};

// 添加优雅关闭
process.on('SIGTERM', () => {
    console.log('收到 SIGTERM 信号，正在关闭服务器...');
    if (server) {
        server.close(() => {
            console.log('服务器已关闭');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

// 在路由分添加状态检查接口
app.get('/api/status', (req, res) => {
    try {
        // 检查 ComfyUI 是否在运行
        if (comfyWs && comfyWs.readyState === WebSocket.OPEN) {
            res.json({ status: 'connected' });
        } else {
            res.status(503).json({ status: 'disconnected' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 在现有的中间件配置之后添加
app.use((req, res, next) => {
    // 添加必要的安全和跨域头
    res.header('Cross-Origin-Embedder-Policy', 'require-corp');
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
});

// 添加一个代理路由来处理 ComfyUI 请求
app.use('/comfyui', async (req, res) => {
    try {
        const comfyuiUrl = 'http://127.0.0.1:8188' + req.url;
        const response = await axios({
            method: req.method,
            url: comfyuiUrl,
            data: req.body,
            headers: {
                ...req.headers,
                host: '127.0.0.1:8188'
            },
            responseType: 'stream'
        });

        // 复制响应头
        Object.entries(response.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
        });

        // 设置必要的跨域头
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        response.data.pipe(res);
    } catch (error) {
        console.error('ComfyUI proxy error:', error);
        res.status(500).json({ error: 'ComfyUI proxy error' });
    }
});

// 添加 OPTIONS 请求处理
app.options('/comfyui/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.sendStatus(200);
});

module.exports = {
    app,
    startServer
}; 