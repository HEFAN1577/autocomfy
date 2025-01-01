const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const express = require('./server.js');
const axios = require('axios');
const fs = require('fs');

// 添加 Store 配置
const store = new Store({
    defaults: {
        comfyuiPath: '',
        pythonPath: 'python'
    }
});

let mainWindow = null;
let splashWindow = null;

// Windows 11 DPI 感知设置
if (process.platform === 'win32') {
    app.commandLine.appendSwitch('high-dpi-support', '1');
    app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

// 创建启动页面窗口
function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 400,
        height: 300,
        frame: false,
        transparent: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        // Windows 11 圆角窗口
        roundedCorners: true,
        // Windows 11 Mica 材质
        backgroundColor: '#00000000',
        vibrancy: 'under-window'
    });

    splashWindow.loadFile('public/splash.html');
}

// 创建主窗口
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        icon: path.join(__dirname, 'public', 'image', 'ComfyuLOGO.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false,
            webviewTag: true,
            additionalArguments: [`--app-path=${app.getAppPath()}`]
        },
        backgroundColor: '#1a1a1a'
    });

    mainWindow.setMenu(null);

    // 启动 Express 服务器
    const PORT = 3005;
    try {
        const server = express.startServer(PORT);
        server.on('error', async (error) => {
            await showCustomDialog({
                type: 'error',
                title: '服务器错误',
                message: '启动服务器失败：' + error.message,
                buttons: ['确定']
            });
            app.quit();
        });
        
        mainWindow.loadURL(`http://localhost:${PORT}`);
    } catch (error) {
        showCustomDialog({
            type: 'error',
            title: '启动错误',
            message: '无法启动应用服务器：' + error.message,
            buttons: ['确定']
        }).then(() => {
            app.quit();
        });
    }

    // Windows 11 窗口状态处理
    mainWindow.on('maximize', () => {
        mainWindow.webContents.send('window-state-changed', 'maximized');
    });

    mainWindow.on('unmaximize', () => {
        mainWindow.webContents.send('window-state-changed', 'normal');
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 主窗口准备就绪后关闭启动页面
    mainWindow.once('ready-to-show', () => {
        setTimeout(() => {
            mainWindow.show();
            if (splashWindow) {
                splashWindow.close();
                splashWindow = null;
            }
        }, 2000);
    });

    // 处理外部链接
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// 自定义对话框处理函数
async function showCustomDialog(options) {
    const dialogWindow = new BrowserWindow({
        width: 400,
        height: 240,
        frame: false,
        transparent: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        parent: mainWindow,
        modal: true,
        show: false,
        // Windows 11 特性
        roundedCorners: true,
        backgroundColor: '#00000000',
        vibrancy: 'under-window'
    });

    await dialogWindow.loadFile('public/components/dialog.html');
    dialogWindow.webContents.send('show-dialog', options);
    dialogWindow.show();

    return new Promise((resolve) => {
        ipcMain.once('dialog-response', (event, response) => {
            dialogWindow.close();
            resolve(response);
        });
    });
}

// 应用启动流程
async function startupFlow() {
    // 设置 Windows 11 DPI 缩放
    if (process.platform === 'win32') {
        const { screen } = require('electron');
        screen.on('display-metrics-changed', (event, display, changedMetrics) => {
            if (mainWindow) {
                mainWindow.webContents.send('display-metrics-changed', display.scaleFactor);
            }
        });
    }

    createSplashWindow();
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const comfyuiPath = store.get('comfyuiPath');
    
    if (!comfyuiPath || !fs.existsSync(path.join(comfyuiPath, 'main.py'))) {
        createMainWindow();
        mainWindow.webContents.on('did-finish-load', () => {
            mainWindow.webContents.send('show-settings');
        });
    } else {
        createMainWindow();
    }
}

// 应用生命周期事件
app.whenReady().then(startupFlow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        startupFlow();
    }
});

// 错误处理
app.on('render-process-gone', async (event, webContents, details) => {
    const response = await showCustomDialog({
        type: 'error',
        title: '程序错误',
        message: '发生了未知错误，程序需要重新启动。',
        buttons: ['确定']
    });
    app.quit();
});

process.on('uncaughtException', async (error) => {
    try {
        if (error.message.includes('ECONNREFUSED 127.0.0.1:8188')) {
            await showCustomDialog({
                type: 'error',
                title: 'ComfyUI 未启动',
                message: '无法连接到 ComfyUI 服务 (127.0.0.1:8188)\n请确保 ComfyUI 已经启动并正常运行。',
                buttons: ['确定']
            });
        } else {
            await showCustomDialog({
                type: 'error',
                title: '程序错误',
                message: '发生了未知错误：' + error.message,
                buttons: ['确定']
            });
        }
    } catch (e) {
        console.error('显示错误对话框失败:', e);
    } finally {
        app.quit();
    }
});

// 添加 IPC 处理程序
ipcMain.handle('get-window-state', () => {
    return mainWindow.isMaximized() ? 'maximized' : 'normal';
});

ipcMain.handle('window-control', (event, command) => {
    switch (command) {
        case 'minimize':
            mainWindow.minimize();
            break;
        case 'maximize':
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
            break;
        case 'close':
            mainWindow.close();
            break;
    }
}); 