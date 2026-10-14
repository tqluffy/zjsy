# ZJSY 来源验证协议 v2

## 概要

旧的主体/白边隐写、纠错码和二维码凭据格式全部移除。新版只在白边下方绘制二维码，不向主体或白边像素写入隐藏数据。二维码包含水印声明、两个已签名摘要和公开密钥 ID。

可信 ECDSA P-256 公钥随验证页发布；签名私钥只保存在 Cloudflare Secret。签名接口公开，不核验调用者身份或网页执行过程。签名表明服务为某摘要生成签名，不证明证件真实、署名者身份或调用者按本站前端操作。

## 水印声明摘要

水印文字由以下显示内容按换行连接，空字段不加入：

1. 用途声明；
2. `有效期至 YYYY-MM-DD`（如果填写）；
3. `签名：...`（如果填写）。

浏览器计算：

    watermarkDigest = SHA-256(UTF8(watermarkText + "https://zjsy.zhtianqi.cn"))

二维码带有 `watermarkText`、小写十六进制 `watermarkDigest` 和签名。验证页只需扫描二维码，即可重算摘要、验证本站公钥签名并显示声明，不需要选择图像。

## 图像主体摘要

主体区域是导出画布中承载原照片的矩形，包含覆盖在照片上的可见水印，不包含白边标题、骑缝文字或二维码页脚。二维码同时携带画布尺寸 `(canvasWidth, canvasHeight)` 和主体矩形 `(x, y, width, height)`。

先对矩形 RGBA 字节计算 SHA-256，再将尺寸与像素摘要绑定：

    pixelDigest = SHA-256(RGBA bytes)
    description = "<canvasWidth>x<canvasHeight>:<x>,<y>,<width>,<height>"
    imageDigest = SHA-256(UTF8("ZJSY-image-content/v2\n" + description + "\n" + lowercaseHex(pixelDigest)))

选择图像后，浏览器在本地重新计算并精确比对 `imageDigest`。尺寸、主体像素或重新编码后的像素变化都会导致核对失败。PNG 更适合保留原始像素；JPG 会对主体有损编码，分享平台再次处理也会改变摘要。

JPG 导出会先在二维码页脚尚未绘制时本地编码并解码，再计算主体摘要。二维码和说明文字随后只绘制在与主体分开的白边页脚，因此不进入主体摘要。

## 签名与二维码

浏览器仅 POST 以下 JSON 到 `/api/sign`：

    {"watermarkDigest":"<64 lowercase hex>","imageDigest":"<64 lowercase hex>"}

接口不会接收水印文字、原始图像、图像像素或元数据。Worker 对两份摘要分别签名，使用 UTF-8 消息：

    ZJSY-watermark-proof/v2
    <keyId>
    <watermarkDigest>

    ZJSY-image-proof/v2
    <keyId>
    <imageDigest>

签名为 64 字节 ECDSA P-256 值，以 Base64URL 放入二维码。二维码指向 `/verify/#p=...`；网址片段不在 HTTP 请求中。扫码器可以记录完整二维码网址，站点无法控制外部扫码软件。

水印文字摘要与图像主体摘要相互独立：前者扫描即可核验，后者需要本地图像像素。二维码明文包含水印文字和摘要。摘要不是加密，不能用来还原原文，但对猜测性较强的短内容可能进行离线枚举。

## 密钥轮换

Cloudflare Secret `ZJSY_SIGNING_KEYS` 使用 JSON 密钥列表：

    {"activeKeyId":"<public id>","keys":{"<public id>":"<Base64 PKCS#8 private key>"}}

Worker 仅用 `activeKeyId` 对应私钥签名。ID 由公钥 SPKI 的 SHA-256 前 8 字节取十六进制得到，公开写入二维码和 `src/verification-keys.js`。生成脚本会把新私钥写入仓库外的本地密钥清单，并将新公钥加入浏览器可信列表；部署时把更新后的密钥清单上传至 Cloudflare Secret。Cloudflare 单个变量上限为 5 KB；清单接近上限时生成脚本会删除旧私钥条目。验证页保留旧公钥即可继续验证先前新版二维码，因为历史核验不需要服务器持有旧私钥。私钥列表只用于运维保管和签名密钥轮换，客户端不信任 QR 自带公钥。[Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

旧版二维码协议不再接受。新版生成的二维码按可信公钥列表验证；从列表撤销某个 ID 会使对应密钥签名的二维码失效。

## 数据处理

Worker 不持久化摘要，不使用数据库、KV、R2、Cookie 或后台任务；项目关闭 Worker observability。平台仍可能处理常规请求元数据。验证页面通过 CSP 禁止连接网络；图像加载、解码、摘要计算和比对在浏览器本地完成。
