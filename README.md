<div align="center">

# 🎬 KathSub — Studio NLE Video Subtitle Editor

<p align="center">
  <strong>Phần mềm biên tập phụ đề video chuyên nghiệp với giao diện Dark Studio phong cách Steam & Linear, tích hợp AI Whisper và kết xuất Hardsub siêu tốc.</strong>
</p>

[![Release](https://img.shields.io/github/v/release/VuHPhuc/KathSub?color=f97316&label=Phi%C3%AAn%20b%E1%BA%A3n)](https://github.com/VuHPhuc/KathSub/releases)
[![Platform](https://img.shields.io/badge/Nền%20tảng-Windows%2010%20%7C%2011-blue.svg)](https://github.com/VuHPhuc/KathSub)
[![License](https://img.shields.io/badge/Giấy%20phép-MIT-green.svg)](LICENSE)

---

</div>

## 📥 Tải về & Cài đặt (Download)

Bạn có thể tải các bản phát hành chính thức trực tiếp tại mục [**Releases**](https://github.com/VuHPhuc/KathSub/releases) trên GitHub:

| Tên tệp | Loại | Mô tả |
| :--- | :---: | :--- |
| [**KathSub-Setup-1.4.1.exe**](https://github.com/VuHPhuc/KathSub/releases) | **Bộ cài đặt (Installer)** | Tự động cài đặt vào máy, tạo biểu tượng ngoài màn hình Desktop và menu Start. Khuyên dùng cho người dùng phổ thông. |
| [**KathSub Portable 1.4.1.exe**](https://github.com/VuHPhuc/KathSub/releases) | **Bản Portable (Chạy ngay)** | Chỉ cần nhấp đúp là mở phần mềm ngay, không cần cài đặt, có thể chép vào USB mang đi mọi nơi. |

> **Lưu ý trên máy tính cục bộ:** Các file `.exe` cài đặt cũng đã được đóng gói sẵn trong thư mục cục bộ tại:  
> `d:\code\KathSub\release\`

---

## ✨ Tính năng nổi bật

### 1. 🎨 Giao diện Dark Studio (Phong cách Steam & Linear)
- **Tông màu Dark Charcoal (`#0d0e12`)** chuyên nghiệp, bề mặt tối giản phẳng (`#1a1c24`), viền tinh tế (`#232631`) và điểm nhấn Cam Hổ Phách (`#f97316`).
- Hệ thống **Icon Vector SVG** đồng bộ 100%, không sử dụng emoji rườm rà.
- Bảng điều khiển phụ đề khoa học gồm 7 nhóm thiết lập: Lời thoại, Mẫu nhanh (Preset), Phông chữ, Màu sắc & Viền, Hộp nền (Box), Căn lề nhanh (Trên/Giữa/Dưới), Đồng bộ hàng loạt.

### 2. 🎞️ Timeline NLE Đa Track Chuẩn Studio
- Hỗ trợ nhiều track trực quan: Video gốc, Phụ đề lời thoại (T1), Nhãn dán / Icon (O1), Dải âm thanh (A1).
- Playhead tracking thời gian thực (hh:mm:ss.ms) đồng bộ 2 chiều với video preview.
- Cho phép cắt phụ đề (phím tắt `S`), co giãn hai đầu để chỉnh mốc thời gian (start/end) trực quan.
- Timeline tự lật trang theo playhead khi đang phát; có thanh cuộn ngang, lăn chuột để cuộn, `Ctrl + lăn chuột` để thu phóng.

### 3. 🎯 Trình xem thử (Preview Overlay) Kéo thả Tức thì
- Kéo thả tự do vị trí phụ đề ngay trên màn hình phát video.
- Thay đổi cỡ chữ, độ dày nét viền, màu sắc, khung nền và thấy ngay kết quả thực tế (WYSIWYG).
- Tính năng **Hút dính (Magnet Snap)** giúp căn chỉnh phụ đề vào giữa hoặc mép khung hình chuẩn xác.
- Ghi nhớ thiết lập người dùng: font/kiểu phụ đề gần nhất, âm lượng và các lựa chọn nhận dạng/dịch được giữ lại sau khi tắt app.

### 4. 🤖 Nhận diện giọng nói đa ngôn ngữ bằng AI Whisper
- Tự động nhận dạng và tách lời thoại từ video / audio sang văn bản kèm mốc thời gian chính xác (timestamp).
- Chạy offline 100% trong tiến trình chính (Node/Electron), bảo vệ quyền riêng tư và hoạt động mượt mà không cần GPU rời.
- Hỗ trợ đa dạng ngôn ngữ: **Tiếng Việt (`vi`)**, **Tiếng Anh (`en`)**, **Tiếng Nhật (`ja`)**, **Tiếng Hàn (`ko`)**, **Tiếng Trung (`zh`)**.
- Tùy chọn kích thước mô hình linh hoạt: `tiny`, `base`, `small`, `medium` và **`large-v3-turbo`** (mặc định, chính xác nhất).
- **Silero VAD** chỉ đưa đoạn có giọng nói vào Whisper và cắt khúc ở chỗ ngắt nghỉ: không còn câu bịa ở chỗ im lặng, không cắt ngang giữa từ, không lặp vô tận.
- Tùy chọn nhận dạng cả tiếng rên, hét có phát âm (イク, あっ...) — kể cả tiếng rên nhỏ kiểu ASMR; tiếng thở, sột soạt, nhạc nền được lọc bỏ để không sinh phụ đề rác.

### 5. 🌐 Dịch thuật phụ đề song ngữ AI (NLLB offline & Ollama AI)
- Dịch tự động lời thoại từ ngôn ngữ gốc sang Tiếng Việt hoặc ngôn ngữ đích khác, tạo phụ đề song ngữ hiển thị trực quan.
- **Dịch offline bằng NLLB (Transformers.js):** Hoạt động ngay trên CPU máy tính mà không cần kết nối Internet.
- **Dịch qua Ollama AI cục bộ:** Kết nối linh hoạt với các mô hình ngôn ngữ lớn (LLM như Qwen 2.5, Qwen 3, Gemma 3, Llama 3...). Model đọc toàn bộ lời thoại trước (nhân vật, giới tính, xưng hô, bối cảnh), dịch từng lô kèm ngữ cảnh trước–sau, tự sửa lỗi nghe nhầm của Whisper, tự dịch lại dòng lệch và có thể soát lại bản dịch lần 2.

### 6. 📦 Tích hợp cài đặt & quản lý Ollama 1-click ngay trong ứng dụng
- Tự động kiểm tra trạng thái cài đặt Ollama trên máy tính.
- Tải về và cài đặt Ollama an toàn với cơ chế xác thực chữ ký số Authenticode (`Ollama Inc.` / DigiCert) trước khi thực thi.
- Khởi động dịch vụ Ollama ngầm và tải các model dịch thuật (như `qwen3:4b`, `qwen2.5:3b`) trực tiếp ngay trong giao diện ứng dụng.

### 7. ⚡ Xuất phụ đề & Render Video Hardsub
- **Xuất phụ đề rời:** Hỗ trợ định dạng chuẩn `.SRT` và Advanced SubStation Alpha (`.ASS`).
- **Render Hardsub:** Tích hợp bộ xử lý FFmpeg render chữ trực tiếp vào video MP4 sắc nét, giữ nguyên tỷ lệ khung hình và chất lượng video gốc.

### 8. 🔔 Tự động cập nhật
- Mỗi lần mở app, KathSub kiểm tra GitHub Releases và hiện thông báo khi có phiên bản mới.
- Bản cài đặt (Setup): bấm **Cập nhật** để tải ngay trong app, xong thì **Khởi động lại & cập nhật** (hoặc để app tự cài khi thoát).
- Bản Portable không tự thay thế được chính nó, nên thông báo chỉ mở trang tải bản mới.

---

## 🚀 Hướng dẫn phát triển từ mã nguồn (Developers)

Nếu bạn là lập trình viên muốn tự biên dịch hoặc tùy biến KathSub:

### Yêu cầu hệ thống
- **Node.js:** phiên bản >= 18.0.0
- **npm:** phiên bản >= 9.0.0
- Hệ điều hành: Windows 10/11 (hoặc macOS/Linux cho bản tương ứng)

### Các bước cài đặt & chạy thử
```bash
# 1. Sao chép kho mã nguồn
git clone https://github.com/VuHPhuc/KathSub.git
cd KathSub

# 2. Cài đặt các thư viện phụ thuộc
npm install

# 3. Chạy môi trường phát triển (Dev Mode)
npm run dev
```

### Đóng gói ứng dụng thành file cài đặt `.exe`
```bash
# Đóng gói cho Windows 64-bit (NSIS Installer + Portable Exe)
npm run dist
```
Các file cài đặt đầu ra sẽ được tạo tại thư mục `release/`:
- `release/KathSub-Setup-<version>.exe` (kèm `KathSub-Setup-<version>.exe.blockmap`)
- `release/KathSub Portable <version>.exe`
- `release/latest.yml`

### Phát hành bản mới (để tính năng tự cập nhật hoạt động)
1. Tăng `version` trong `package.json`, chạy `npm run dist`.
2. Tạo GitHub Release với tag `v<version>` và tải lên **cả 4 file**: `latest.yml`, `KathSub-Setup-<version>.exe`, `KathSub-Setup-<version>.exe.blockmap`, `KathSub Portable <version>.exe`.
3. Giữ nguyên tên `KathSub-Setup-<version>.exe` (có dấu gạch ngang) vì `latest.yml` trỏ đúng tên này. Thiếu `latest.yml` thì bản cài đặt sẽ không thấy bản mới.

---

## ⌨️ Phím tắt hữu dụng

| Phím tắt | Chức năng |
| :---: | :--- |
| `Space` | Tạm dừng / Tiếp tục phát video |
| `S` | Cắt đôi đoạn phụ đề tại vị trí con trỏ timeline |
| `Del` | Xóa đoạn phụ đề đang chọn |
| `←` / `→` | Tua lùi / tiến 1 khung hình |
| `Ctrl + Z` | Hoàn tác thao tác |

---

## 📄 Bản quyền & Tác giả

Phát triển bởi **Vũ Phúc** ([@VuHPhuc](https://github.com/VuHPhuc)).  
Mã nguồn phát hành dưới giấy phép mã nguồn mở [MIT License](LICENSE).

