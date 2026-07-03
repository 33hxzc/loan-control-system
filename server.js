const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 头像上传文件夹初始化
const uploadDir = path.join(__dirname, 'public/upload');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const username = req.loginUser.username;
    const ext = path.extname(file.originalname);
    cb(null, `${username}_avatar${ext}`);
  }
});
const upload = multer({ storage: storage });

// 持久化数据文件初始化
const DEVICE_FILE = './devices.json';
const LOG_FILE = './operateLog.json';
const ACCOUNT_FILE = './accountList.json';
if (!fs.existsSync(DEVICE_FILE)) fs.writeFileSync(DEVICE_FILE, JSON.stringify([]));
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, JSON.stringify([]));
if (!fs.existsSync(ACCOUNT_FILE)) {
  // 默认主账号，自带头像空字段
  const initAccount = [
    { username: "admin", pwd: "888888", role: "master", avatar: "", createTime: new Date().toLocaleString() }
  ];
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(initAccount, null, 2));
}

// 账号读写工具
function getAccountList() {
  return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
}
function saveAccountList(list) {
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(list, null, 2));
}
// 设备读写
function getDevices() {
  return JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'));
}
function saveDevices(list) {
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(list, null, 2));
}
// 日志读写
function getLogs() {
  return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
}
function saveLog(item) {
  let logs = getLogs();
  logs.unshift(item);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

const deviceMap = new Map();
let controlWs = null;
let loginUser = null;

// 登录鉴权中间件
function checkLogin(req, res, next) {
  if (!loginUser) return res.json({ code: 401, msg: "请重新登录系统" });
  req.loginUser = loginUser;
  next();
}

// ========== 1. 主管理员专属接口：新增/删除其他账号、修改他人密码 ==========
app.get('/api/getAllAccount', checkLogin, (req, res) => {
  if (req.loginUser.role !== "master") return res.json({ code: 403, msg: "仅主管理员可管理其他账号" });
  res.json({ list: getAccountList() });
});
app.post('/api/addSubAccount', checkLogin, (req, res) => {
  if (req.loginUser.role !== "master") return res.json({ code: 403, msg: "仅主管理员可新增子账号" });
  const { username, pwd } = req.body;
  let accountList = getAccountList();
  if (accountList.find(u => u.username === username)) return res.json({ code: 400, msg: "账号已存在" });
  accountList.push({
    username, pwd, role: "sub", avatar: "", createTime: new Date().toLocaleString()
  });
  saveAccountList(accountList);
  res.json({ code: 200 });
});
app.post('/api/delAccount', checkLogin, (req, res) => {
  if (req.loginUser.role !== "master") return res.json({ code: 403, msg: "仅主管理员可删除账号" });
  const { username } = req.body;
  if (username === "admin") return res.json({ code: 400, msg: "禁止删除主管理员账号" });
  let accountList = getAccountList().filter(u => u.username !== username);
  saveAccountList(accountList);
  res.json({ code: 200 });
});
app.post('/api/editOtherPwd', checkLogin, (req, res) => {
  if (req.loginUser.role !== "master") return res.json({ code: 403, msg: "仅主管理员可修改他人密码" });
  const { username, newPwd } = req.body;
  let accountList = getAccountList();
  const target = accountList.find(u => u.username === username);
  if (!target) return res.json({ code: 400, msg: "账号不存在" });
  target.pwd = newPwd;
  saveAccountList(accountList);
  res.json({ code: 200 });
});

// ========== 2. 全账号通用：自主修改自己的登录密码（主/子均可） ==========
app.post('/api/editSelfPwd', checkLogin, (req, res) => {
  const { oldPwd, newPwd } = req.body;
  const user = req.loginUser;
  let accountList = getAccountList();
  const target = accountList.find(u => u.username === user.username);
  if (target.pwd !== oldPwd) return res.json({ code: 400, msg: "原密码输入错误" });
  target.pwd = newPwd;
  saveAccountList(accountList);
  res.json({ code: 200, msg: "个人密码修改成功" });
});

// ========== 3. 全账号通用：上传个人头像（主/子均可） ==========
app.post('/api/uploadAvatar', checkLogin, upload.single('avatar'), (req, res) => {
  const user = req.loginUser;
  const avatarPath = `/upload/${req.file.filename}`;
  let accountList = getAccountList();
  const target = accountList.find(u => u.username === user.username);
  target.avatar = avatarPath;
  saveAccountList(accountList);
  res.json({ code: 200, avatar: avatarPath });
});

// ========== 登录校验接口 ==========
app.post('/api/login', (req, res) => {
  const { username, pwd } = req.body;
  const accountList = getAccountList();
  const userInfo = accountList.find(u => u.username === username && u.pwd === pwd);
  if (userInfo) {
    loginUser = userInfo;
    res.json({ code: 200, user: userInfo });
  } else {
    res.json({ code: 403, msg: "账号或密码错误" });
  }
});

// 设备相关接口（所有账号权限一致）
app.get('/api/deviceList', (req, res) => res.json(getDevices()));
app.post('/api/editDevName', (req, res) => {
  const { devId, name } = req.body;
  let list = getDevices();
  const item = list.find(d => d.id === devId);
  if (item) item.name = name;
  saveDevices(list);
  res.json({ code: 200 });
});
app.post('/api/delDevice', (req, res) => {
  const { devId } = req.body;
  let list = getDevices().filter(d => d.id !== devId);
  saveDevices(list);
  const info = deviceMap.get(devId);
  if (info && info.ws) info.ws.close();
  deviceMap.delete(devId);
  if (controlWs) controlWs.send(JSON.stringify({
    type: 'deviceList',
    list: getDevices()
  }));
  res.json({ code: 200 });
});
app.get('/api/exportLog', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment;filename=设备捕获日志.json');
  res.send(JSON.stringify(getLogs(), null, 2));
});

// WebSocket通讯（页面打开自动绑定设备，无二维码）
wss.on('connection', (ws) => {
  let heartbeatTimer = setInterval(() => ws.ping(), 25000);
  ws.on('close', () => clearInterval(heartbeatTimer));
  ws.on('message', raw => {
    const data = JSON.parse(raw);
    if (data.type === 'controlClient') {
      controlWs = ws;
      ws.send(JSON.stringify({ type: 'deviceList', list: getDevices() }));
      return;
    }
    // 安卓打开bind.html自动绑定设备
    if (data.type === 'bindDevice') {
      const devId = data.deviceId;
      deviceMap.set(devId, { ws, screenOff: false });
      let devList = getDevices();
      if (!devList.find(d => d.id === devId)) {
        devList.push({
          id: devId,
          name: "未命名收款设备",
          bindTime: new Date().toLocaleString(),
          online: true
        });
        saveDevices(devList);
      }
      if (controlWs) controlWs.send(JSON.stringify({ type: 'deviceList', list: getDevices() }));
      return;
    }
    // 下发远程控制指令
    if (data.type === 'cmd') {
      const targetDev = deviceMap.get(data.devId);
      if (!targetDev) return;
      targetDev.ws.send(raw);
      if (data.action === 'inputText') {
        saveLog({
          time: new Date().toLocaleString(),
          devId: data.devId,
          type: "控制端下发输入",
          content: data.content,
          operator: loginUser.username
        });
      }
      return;
    }
    // 安卓推流、捕获填写信息
    if (data.type === 'devStream' || data.type === 'inputCapture') {
      if (data.type === 'inputCapture') {
        saveLog({
          time: new Date().toLocaleString(),
          devId: data.devId,
          type: "被控设备输入捕获",
          content: data.text,
          operator: loginUser.username
        });
      }
      if (controlWs) controlWs.send(raw);
    }
  });
  // 设备离线标记
  ws.on('close', () => {
    for (let [did, info] of deviceMap.entries()) {
      if (info.ws === ws) {
        let devList = getDevices();
        const idx = devList.findIndex(d => d.id === did);
        if (idx > -1) devList[idx].online = false;
        saveDevices(devList);
        deviceMap.delete(did);
        if (controlWs) controlWs.send(JSON.stringify({
          type: 'deviceList',
          list: getDevices()
        }));
        break;
      }
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("系统启动：支持头像上传、全账号自主改密码，安卓访问 /bind.html 自动绑定设备");
});
