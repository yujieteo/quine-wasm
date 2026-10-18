# BabyDig

Search your files by what is in them. BabyDig is one HTML file. You do not install it, and it sends nothing over the network: the search model is inside the file, and the index stays in your browser.

Type what you remember ("the clause about pets in the lease", "invoice that was paid late") and BabyDig finds the file, the page and the passage.

## Use it

1. Get `babydig.html`. If you cannot download files, open the file on GitHub, click **Raw**, select all the text, copy it, and paste it into Notepad. Save it as `babydig.html` with "Save as type" set to **All files**. The file is plain ASCII, so the encoding does not matter.
2. Open `babydig.html` in Microsoft Edge or Google Chrome.
3. Click **+ Folder** and select a folder. Network folders and mapped drives also work. Indexing starts immediately.
4. Type in the search box. Click a result to open it. Ctrl+click copies its path. Use the arrow keys and Enter if you prefer the keyboard.
5. Click **Update** to read new and changed files. Files that did not change are not read again.

Add each folder that you want to search. The browser does not let a page open a full drive or your full user folder.

## What it reads

| Type | Files |
|---|---|
| Documents | `.pdf` (text layer, by page), `.docx`, `.doc` |
| Spreadsheets | `.xlsx`, `.xls` (by sheet), `.csv` |
| Slides | `.pptx`, `.ppt` (by slide) |
| Email | `.msg` (sender, recipients, subject, body, and the supported attachments) |
| Text and code | `.txt`, `.md`, and common code files |
| Archives | the supported files inside `.zip` files |

BabyDig does not open other files. It does not skip folders, and it has no file-size limit. Very large text files are read in parts. Passages that are almost only numbers (for example, solver output) are not stored.

## How it works

- **Meaning search:** [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), a static embedding model from Minish Lab (Model2Vec), quantized to 6 bits (7 MB). Its results are almost identical to the full model (lowest cosine similarity 0.999 in tests).
- **Speed:** the tokenizer and the embedder are written in C and compiled to WebAssembly. They run in Web Workers, one for each CPU core. PDFs are read by [PDF.js](https://mozilla.github.io/pdf.js/) in separate workers.
- **Exact words:** each passage has a 64-byte word fingerprint, so names and codes such as `INV-2024-00931` are found without a scan of all the text.
- **Search:** one SIMD pass over all passage vectors. 1,000,000 passages take approximately 90 ms.
- **Storage:** the index is kept in the browser's IndexedDB storage.

## Limits

- Meaning search works in English. Other languages are found by exact words only.
- Images and scanned PDFs without a text layer are not read.
- A browser cannot start Word or Excel. **Open** shows PDFs, text and code in a new tab. For Office files, it downloads a copy. **Copy path** gives the path inside the folder that you added.
- If you clear the browser's site data, the index is deleted. Your files do not change.
- An index of millions of passages needs a large amount of memory. Add the folders that you search, not full drives.
- Edge and Chrome are supported. Other browsers can index a folder, but they cannot update it later.

## License

BabyDig is released under the [MIT License](LICENSE).

`babydig.html` also contains:

- **potion-base-8M** by Minish Lab, MIT License. Copyright (c) 2024 MinishLab. Distilled from BAAI/bge-base-en-v1.5 (MIT).
- **PDF.js** by Mozilla, [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The worker build is changed to load as a classic script.
