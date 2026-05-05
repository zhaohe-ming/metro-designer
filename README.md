## Metro Designer

### 本地运行

1. 安装依赖

```bash
npm install
```

2. 前后端一起启动

```bash
npm run dev
```

- 前端: `http://localhost:3000`
- 后端: `http://localhost:4000`

### 后端能力

- 注册 / 登录（JWT）
- 个人信息读取与更新
- 地图保存 / 地图列表 / 地图加载 / 地图删除

### 数据持久化

- 数据落盘文件: `server/data/db.json`
- 服务重启后数据仍保留
