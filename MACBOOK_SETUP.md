# Chuyển Night Market Checker sang MacBook

## Cài lần đầu

1. Giải nén `nightmarket-checker-mac.zip` vào một thư mục riêng.
2. Cài Google Chrome bản mới nhất.
3. Cài Node.js 20 trở lên từ `https://nodejs.org`.
4. Mở Terminal tại thư mục dự án và chạy:

```bash
zsh start-mac.command
```

Dashboard sẽ mở tại `http://127.0.0.1:3210`.

Nếu macOS chặn file được tải về, vẫn có thể chạy trực tiếp bằng lệnh `zsh start-mac.command`. Nếu muốn bấm đúp file:

```bash
chmod +x start-mac.command
```

## Profile và dữ liệu

- Gói ZIP không chứa `profiles/`, `runtime/`, `results/` hoặc `node_modules/`.
- Cookie Chrome trên Windows được mã hóa theo Windows và không nên chuyển sang macOS. Hãy mở từng luồng và đăng nhập Menzu lại trên Mac.
- Chọn file Excel bằng dashboard; không cần giữ đường dẫn Windows `C:\\Users\\...`.
- Kết quả mới sẽ nằm trong `results/` trên Mac.

## Khi Chrome nằm ở vị trí khác

Ứng dụng tự tìm Chrome tại đường dẫn macOS tiêu chuẩn. Nếu cần chỉ định thủ công:

```bash
export NIGHTMARKET_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npm start
```

## Kiểm tra trước khi chạy thật

```bash
npm ci
npm test
npm run check
```

Nên thử với một tài khoản và chế độ hiện trình duyệt trước. Riot có thể yêu cầu CAPTCHA/MFA hoặc từ chối đăng nhập tự động. Không cố vượt CAPTCHA; hướng an toàn là chế độ hỗ trợ đăng nhập thủ công rồi tự động hóa phần Menzu còn lại.
