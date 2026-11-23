# 語音提詞器 Voice Teleprompter

簡報用的網頁提詞器。照著講稿說話，畫面會依照你說到哪裡自動捲動。純靜態網頁（HTML + CSS + JS），不用安裝、不用後端，可以直接放在 GitHub Pages。

## 功能

- **語音追蹤**：用瀏覽器內建的語音辨識（Web Speech API）聽你說話，用模糊對齊找出你唸到哪個字。唸錯字、停頓、略過一段都追得回來。
- **匯入講稿**：`.txt`、`.md`、`.docx`，以及 `.pptx`（讀取每張投影片的演講者備忘稿，依投影片順序排列）。可以直接拖曳檔案進來。
- **講稿標記**：`# 標題` 是段落標題，`[停頓]`、`【換投影片】` 是提示，都不用唸出來。
- **另外兩種模式**：固定速度捲動，以及手動（鍵盤、簡報筆、滾輪）。
- 左右鏡像（提詞玻璃）、上下翻轉、字級、行距、寬度、閱讀線位置都能調。
- 計時器、進度百分比、目前段落名稱；防止螢幕休眠。
- 講稿和設定存在瀏覽器的 localStorage，下次打開還在，可以從上次位置繼續。

## 瀏覽器支援

| 瀏覽器 | 語音追蹤 |
| --- | --- |
| Chrome / Edge（桌機、Android） | 可以（音訊會送到 Google / Microsoft 的伺服器辨識，需要網路） |
| Safari（macOS、iOS / iPadOS） | 可以 |
| Firefox | 不支援，請用固定速度或手動模式 |

麥克風只能在 **HTTPS** 或 `localhost` 下使用。GitHub Pages 預設就是 HTTPS。

## 部署到 GitHub Pages

1. 在 GitHub 建立一個新的 repository，例如 `teleprompter`（Public；免費方案的 Pages 需要 Public）。
2. 上傳這幾個檔案到 repository 根目錄：`index.html`、`style.css`、`app.js`、`manifest.webmanifest`、`icon-180.png`、`icon-192.png`、`icon-512.png`、`.nojekyll`（`README.md` 可選）。
   - 網頁上傳：repo 頁面 → **Add file → Upload files** → 拖進去 → Commit。
   - 或用 git：
     ```bash
     git init
     git add index.html style.css app.js manifest.webmanifest icon-*.png .nojekyll README.md .gitignore
     git commit -m "Voice teleprompter"
     git branch -M main
     git remote add origin https://github.com/<你的帳號>/teleprompter.git
     git push -u origin main
     ```
3. repo 的 **Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)`，按 Save。
4. 等一兩分鐘，網址會是 `https://<你的帳號>.github.io/teleprompter/`。第一次按「開始提詞」時，瀏覽器會詢問麥克風權限，選允許。

## iPhone / iPad

- 用 **Safari** 開啟網址。第一次按「開始提詞」會詢問麥克風和語音辨識權限，都要允許。如果一直失敗，到「設定 → 一般 → 鍵盤」開啟「啟用聽寫」。
- **把網站的咪高峰設成「允許」**：網址列「大小」（aA）→「網站設定」→「咪高峰」→「允許」。預設是「詢問」，Safari 每次重新開始聆聽都會再跳出詢問，那時辨識就會停住。
- 如果咪高峰完全收不到聲音（測試頁音量條不動），通常是其他 App 佔用了咪高峰；關掉那些 App 或重新開機。
- 觸控操作：**點一下**顯示／隱藏控制列（在畫面下方），**長按**某個字把進度設在那裡，**上下拖曳**手動捲動，**兩指縮放**調整字級。
- 提詞時保持畫面在前景；切到別的 App 或鎖定畫面會自動暫停，回來後點 ▶ 繼續。
- iPhone 的 Safari 不支援網頁全螢幕，所以沒有全螢幕按鈕。可以橫放手機，或在 Safari 按「分享 → 加入主畫面」，從主畫面開啟就沒有網址列。
- 注意：從主畫面開啟時，部分 iOS 版本不提供語音辨識（設定頁會顯示提示）。遇到這種情況就改在 Safari 裡用。
- 藍牙簡報筆和鍵盤一樣可以用（PageUp / PageDown）。

## 本機測試

```bash
python3 -m http.server 8765
```

然後開 http://localhost:8765 。

## 使用提示

- 講稿是繁體中文就選「中文（台灣）」或「粵語（香港）」，簡體就選「普通话」，辨識出來的字形要跟講稿一致才對得上。
- 粵語辨識常會輸出口語字（係、咗、嘅），如果講稿是書面語，對齊會比較依賴前後文，建議講稿盡量貼近實際說法。
- 數字在講稿和辨識結果可能寫法不同（「2026」和「二零二六」），通常前後文夠就能對上，不行就點一下文字手動對位。
- 打開「顯示辨識到的文字」可以看到瀏覽器實際聽到什麼，方便排查。

## 快捷鍵

| 按鍵 | 作用 |
| --- | --- |
| 空白鍵 | 開始／暫停 |
| ← → | 上一句／下一句（固定速度模式：上一段／下一段） |
| ↑ ↓ | 上一段／下一段（固定速度模式：調整速度） |
| PageUp / PageDown | 上一段／下一段（簡報筆） |
| + − | 字級 |
| M | 左右鏡像 |
| F | 全螢幕 |
| Home / End | 回到開頭／跳到結尾 |
| Esc | 回到編輯 |
| 編輯畫面 Ctrl/⌘ + Enter | 開始提詞 |
