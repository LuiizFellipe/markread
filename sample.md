# MarkRead Sample Document

Welcome to **MarkRead**! This file exercises every feature of the renderer —
keep it around as a visual test document.

## Text formatting

Regular text, **bold**, *italic*, ~~strikethrough~~, `inline code`, and
[external links](https://github.com) all render GitHub-style. Autolinks like
https://tauri.app work without explicit markup.

## Lists

1. Ordered items
2. Second item
   - Nested unordered
   - Another nested item

### Task list

- [x] Render markdown
- [x] Register file associations
- [ ] Take over the world

## Table

| Feature        | Status | Notes                        |
| -------------- | ------ | ---------------------------- |
| GFM tables     | ✅     | With alignment support       |
| Syntax highlight | ✅   | highlight.js, many languages |
| Dark mode      | ✅     | Manual toggle + follow OS    |

## Code blocks

```rust
fn main() {
    let reader = "MarkRead";
    println!("Hello from {reader}!");
}
```

```javascript
const files = ["README.md", "sample.md"];
console.log(`Opening ${files.length} files`);
```

```bash
# Build the .deb installer (Linux)
npm run tauri:build
```

## Quotes and rules

> "The scrollytelling of a good markdown file is the closest
> a document gets to being alive."
>
> — someone, probably

---

## Related file

Links to other markdown files open in-app:
[README.md](README.md)

## Image

Relative images resolve against this file's folder:

![App icon](src-tauri/icons/128x128.png)
