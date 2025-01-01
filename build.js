const fs = require('fs-extra');
const path = require('path');

// 复制必要的资源文件
async function copyResources() {
    try {
        // 首先确保 dist 目录存在
        const distDir = path.join(__dirname, 'dist');
        await fs.ensureDir(distDir);

        const resourcesToCopy = [
            {
                from: path.join(__dirname, 'public', 'image'),
                to: path.join(distDir, 'image')
            }
        ];

        // 需要创建的空目录列表
        const emptyDirs = [
            'saved_images',
            'preset',
            'workflow'
        ];

        // 复制现有资源
        for (const resource of resourcesToCopy) {
            if (await fs.pathExists(resource.from)) {
                await fs.copy(resource.from, resource.to);
                console.log(`Copied ${resource.from} to ${resource.to}`);
            }
        }

        // 创建空目录
        for (const dir of emptyDirs) {
            const dirPath = path.join(distDir, dir);
            await fs.ensureDir(dirPath);
            console.log(`Created directory: ${dirPath}`);

            // 如果源目录存在且有内容，复制内容
            const sourcePath = path.join(__dirname, dir);
            if (await fs.pathExists(sourcePath)) {
                const files = await fs.readdir(sourcePath);
                if (files.length > 0) {
                    await fs.copy(sourcePath, dirPath);
                    console.log(`Copied contents from ${sourcePath} to ${dirPath}`);
                }
            }
        }

        console.log('Resource copy completed successfully');
    } catch (error) {
        console.error('Error during resource copy:', error);
        throw error;
    }
}

// 在打包过程中调用
copyResources().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
}); 