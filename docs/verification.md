# ZJSY 来源验证协议 v3

## 概要

协议只在白边绘制可见二维码，不在照片主体中写入隐藏数据。白边左上角有网站首页二维码、Logo 和地址；启用验证后，白边下方增加中心带 Logo 的签名二维码。照片四角外的白边中会绘制四个 QR finder 风格定位块。

二维码包含水印文字声明、图像主体感知指纹、两份签名摘要，以及公开密钥 ID。水印签名扫码即可核验；图像指纹需要选择图像并在本地验证。可信 ECDSA P-256 公钥随验证页发布，签名私钥只保存在 Cloudflare Secret。签名服务公开，不核验调用者或网页执行过程。

## 水印声明摘要

水印文字由以下显示内容按换行连接，空字段不加入：

1. 用途声明；
2. `有效期至 YYYY-MM-DD`（如果填写）；
3. `签名：...`（如果填写）。

浏览器计算：

    watermarkDigest = SHA-256(UTF8(watermarkText + "https://zjsy.zhtianqi.cn"))

二维码带有 `watermarkText`、小写十六进制 `watermarkDigest` 和签名。验证页扫描后在本地重算摘要、验证本站公钥签名并显示声明，不需要选择图像。

## 图像主体指纹

主体是画布中承载原照片的矩形，包含可见水印，不包含白边标题、四角定位块、骑缝文字或二维码。二维码签名图像画布尺寸、主体矩形和定位块尺寸；定位块在主体左右两侧的白边中。

浏览器将主体等比缩到 32×32 灰度图，生成两种感知哈希：

- **pHash**：对灰度图计算 16×16 低频 DCT 系数（排除 DC），用中位数阈值编码为 256 位；
- **dHash**：对 9×8 采样点逐行比较亮度，编码为 64 位；
- **cHash**：对 4×4 主体分区计算平均 Cb/Cr 色度，各量化为 4 位，共 128 位。

三组特征构成 56 字节指纹。其摘要将画布尺寸、主体矩形、定位块尺寸和指纹绑定：

    featureHash = SHA-256(fingerprint bytes)
    description = "<canvasWidth>x<canvasHeight>:<x>,<y>,<width>,<height>:m<markerSize>"
    imageDigest = SHA-256(UTF8("ZJSY-image-content/v3\n" + description + "\n" + lowercaseHex(featureHash)))

验证时先要求图像整体等比缩放（宽高比例误差不超过 1%），再按已签名的主体边界检查四个定位块。只有四个 finder pattern 均匹配，才会对它们围住的主体区域计算指纹。裁切、非等比变形或定位块损坏都会失败，不尝试从二维码或白边之外推测主体。

距离 `pHash ≤ 18/256`、`dHash ≤ 8/64`、32 个色度量化值的差异总和 `≤ 32` 且单项色度差异 `≤ 4/15` 时允许通过；零差异显示完全一致，非零但在阈值内显示“轻微失真容差内匹配”。较大修改、明显颜色变化、不同图像和严重压缩仍会失败。感知哈希不能证明每个像素未改，也可能将视觉相似图像视为接近；它用于抵抗轻微传输失真，不等同于精确像素摘要。

JPG 导出会先在本地编码、解码主体区域，再计算感知指纹。主体以外的定位块和白边二维码不参与主体指纹。

## 签名与二维码

浏览器仅 POST 以下 JSON 到 `/api/sign`：

    {"watermarkDigest":"<64 lowercase hex>","imageDigest":"<64 lowercase hex>"}

接口不会接收水印文字、图像像素、原图或原始主体特征。Worker 对两份摘要分别签名，使用 UTF-8 消息：

    ZJSY-watermark-proof/v3
    <keyId>
    <watermarkDigest>

    ZJSY-image-proof/v3
    <keyId>
    <imageDigest>

签名为 64 字节 ECDSA P-256 值，以 Base64URL 放入二维码。签名二维码使用高纠错等级，在中心覆盖白底 Logo。二维码指向 `/verify/#p=...`；网址片段不在 HTTP 请求中。扫码软件可能记录完整网址。

二维码里的短感知指纹不包含可还原原图的像素，但可以粗略反映主体结构；签名接口只收到指纹摘要。

## 密钥轮换

Cloudflare Secret `ZJSY_SIGNING_KEYS` 使用 JSON 密钥列表：

    {"activeKeyId":"<public id>","keys":{"<public id>":"<Base64 PKCS#8 private key>"}}

Worker 仅用 `activeKeyId` 对应私钥签名。ID 由公钥 SPKI 的 SHA-256 前 8 字节取十六进制得到，公开写入二维码和 `src/verification-keys.js`。生成脚本会把新私钥写入仓库外的本地密钥清单，并将新公钥加入浏览器可信列表；部署时把更新后的密钥清单上传至 Cloudflare Secret。Cloudflare 单个变量上限为 5 KB；清单接近上限时生成脚本会删除旧私钥条目。历史验证由浏览器保留的旧公钥完成，不需要服务器保留旧私钥。[Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

旧二维码协议不再接受。新版二维码按可信公钥列表验证；从列表撤销某个 ID 会使对应密钥签名的二维码失效。

## 数据处理

Worker 不持久化摘要，不使用数据库、KV、R2、Cookie 或后台任务；项目关闭 Worker observability。平台仍可能处理常规请求元数据。验证页面通过 CSP 禁止连接网络；图像解码、定位块识别、指纹计算和比对都在浏览器本地完成。
