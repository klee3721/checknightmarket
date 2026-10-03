# Chuyển Night Market Checker sang Windows

Tài liệu này là điểm bàn giao cho người dùng và Codex khi clone repository trên máy Windows. Đọc cùng `README.md` và `AGENTS.md` trước khi sửa code.

## Trạng thái hỗ trợ hiện tại

- Server, dashboard, đọc Excel/CSV, lưu kết quả và tìm Chrome/Edge đã dùng API đa nền tảng.
- `src/utils.js` tự tìm Chrome/Edge ở các đường dẫn Windows tiêu chuẩn. Có thể ghi đè bằng `NIGHTMARKET_BROWSER`.
- Luồng đăng nhập Riot **hiện trình duyệt** chưa hoàn tất cho Windows: hàm `regularChromeTabUrls()` trong `src/automation.js` đang dùng AppleScript của macOS để đọc URL token.
- Không chép `profiles/`, `runtime/`, `results/`, cookie hoặc profile Chrome từ Mac sang Windows. Hãy đăng nhập Menzu lại trên Windows.

## Cài và chạy lần đầu

1. Cài Git, Node.js 20 trở lên và Google Chrome hoặc Microsoft Edge bản mới nhất.
2. Clone repository rồi mở PowerShell tại thư mục dự án.
3. Chạy các lệnh kiểm tra sạch:

```powershell
npm ci
npm run check
npm test
npm audit --omit=dev
```

4. Chạy `start.bat` hoặc `npm start`, rồi mở `http://127.0.0.1:3210`.
5. Nạp một file mẫu không chứa tài khoản thật để kiểm tra UI trước.

Nếu trình duyệt nằm ở vị trí khác:

```powershell
$env:NIGHTMARKET_BROWSER = 'D:\Apps\Chrome\chrome.exe'
npm start
```

## Việc Codex trên Windows cần làm

### 1. Thay phần đọc URL tab dành riêng cho macOS

Điểm cần sửa nằm ở `regularChromeTabUrls()` và `obtainTokenWithRegularChrome()` trong `src/automation.js`.

Giữ nguyên các yêu cầu sau:

- Tab Menzu của worker phải được giữ mở trong toàn bộ lượt chạy.
- Link Riot OAuth chỉ lưu trong RAM và được tái sử dụng trong worker; không ghi link vào file hoặc log.
- Người dùng tự đăng nhập Riot và xử lý CAPTCHA/MFA, sau đó bấm nút tiếp tục trên dashboard.
- Chỉ chấp nhận URL đúng dạng `http://localhost/redirect#...` và có tham số `access_token`.
- Không đưa URL token, mật khẩu hoặc cookie vào log, API trạng thái, ảnh preview hay kết quả.
- Không thêm CAPTCHA bypass, stealth, fingerprint spoofing, proxy rotation hoặc code né phát hiện tự động hóa.

Hướng triển khai ưu tiên là tách việc lấy danh sách URL tab thành adapter theo hệ điều hành. Trên Windows, dùng DevTools endpoint cục bộ của đúng Chrome profile tạm đã mở với một cổng ngẫu nhiên khác 0. Chỉ kết nối tới `127.0.0.1`, giữ kiểm tra URL nghiêm ngặt và không log payload trả về. Không dùng `--remote-debugging-port=0`; cấu hình đó từng làm `navigator.webdriver` bật và có thể kích hoạt chặn đăng nhập.

Sau khi triển khai, kiểm tra trên tab đăng nhập thật rằng `navigator.webdriver === false` trước khi chạy tài khoản. Nếu điều này không đúng, dừng và sửa cách khởi chạy; không che hoặc ghi đè thuộc tính bằng script.

### 2. Kiểm tra tái sử dụng Chrome Riot

Khi tùy chọn **Đóng Chrome Riot sau mỗi tài khoản** tắt, cùng cửa sổ Chrome phải được giữ lại, đăng xuất tài khoản cũ, xóa riêng cookie/storage Riot và dùng cho lượt kế tiếp. Khi bật, chỉ đóng tiến trình/profile Riot tạm của worker đó.

Không dùng `taskkill /IM chrome.exe`, `taskkill /IM msedge.exe` hoặc lệnh tương đương vì sẽ đóng cả trình duyệt cá nhân của người dùng. Mọi cleanup phải dựa trên PID đã spawn hoặc `--user-data-dir` nằm trong `runtime/worker-*` hay `profiles/worker-*` của chính project.

### 3. Hoàn thiện launcher Windows

`start.bat` hiện là launcher tối thiểu. Nếu bổ sung cơ chế restart/cleanup, phải đạt các điều kiện:

- Chỉ dừng server đang nghe cổng 3210 khi tiến trình đó thuộc đúng thư mục project này.
- Chỉ dọn Chrome/Edge được project mở bằng profile riêng của project.
- Không mở thêm dashboard hoặc terminal nếu đã có phiên của project đang chạy.
- Không đóng tab, cửa sổ trình duyệt hoặc terminal không thuộc project.

## Checklist nghiệm thu trên Windows

1. `npm ci`, `npm run check`, `npm test`, `npm audit --omit=dev` đều thành công.
2. Dashboard tải ở `http://127.0.0.1:3210` và Console không có lỗi.
3. Chạy thử đúng một tài khoản ở chế độ hiện trình duyệt, một worker, preview bật.
4. Tab Menzu không bị đóng khi mở và hoàn tất OAuth Riot.
5. URL token được nhận nhưng không xuất hiện trong log, SSE, ảnh hoặc `results.csv`.
6. Ảnh Night Market được lưu đúng; card lưu trữ trên Menzu được xóa sau khi thành công.
7. Tùy chọn giữ Chrome Riot hoạt động qua hai lượt liên tiếp mà không còn phiên tài khoản cũ.
8. Restart không để lại server, tab dashboard hoặc terminal thừa của project.
9. Chỉ sau khi kiểm tra một tài khoản thành công mới tăng số worker.

Nếu selector Menzu/Riot thay đổi, chỉ cập nhật `config.json` sau khi quan sát giao diện thật. Không đưa dữ liệu đăng nhập hoặc URL token vào fixture/test.
