# 手机步数上传设置

这个项目现在支持手机把今日步数上传到本地或云端 Node 后端，然后主页通过 `/api/steps` 显示。

## 1. 配置后端

复制 `server/.env.example` 为 `server/.env`，至少改这两项：

```env
PUBLIC_BASE_URL=http://localhost:3000
STEPS_UPLOAD_TOKEN=换成一串只有你知道的随机字符
```

如果部署到云端，把 `PUBLIC_BASE_URL` 改成你的公网地址，例如：

```env
PUBLIC_BASE_URL=https://your-domain.example
```

## 2. 启动后端

```powershell
cd server
npm start
```

## 3. 测试上传

浏览器打开：

```text
http://localhost:3000/api/steps/upload-url
```

它会返回一个测试上传 URL。也可以直接访问：

```text
http://localhost:3000/api/steps/manual?steps=12345&token=你的_TOKEN
```

成功后再打开：

```text
http://localhost:3000/api/steps
```

应该能看到刚上传的步数。

## 4. iPhone 快捷指令思路

创建个人自动化，例如每小时运行一次：

1. 查找健康样本：类型选“步数”，范围选“今天”。
2. 统计/求和这些步数样本。
3. 获取 URL 内容：方法选 `POST`，URL 填 `https://你的后端/api/steps/manual`。
4. 请求正文选 JSON：

```json
{
  "steps": "上一步求和结果",
  "token": "你的_TOKEN",
  "device": "iPhone"
}
```

本地开发时，手机不能访问电脑的 `localhost`，要用电脑在同一 Wi-Fi 下的局域网 IP，例如：

```text
http://192.168.1.23:3000/api/steps/manual
```

## 5. Android 自动化思路

用 Tasker / MacroDroid / 自写小 App 读取当天步数，再向同一个接口发送 POST JSON：

```json
{
  "steps": 12345,
  "token": "你的_TOKEN",
  "device": "Android"
}
```
