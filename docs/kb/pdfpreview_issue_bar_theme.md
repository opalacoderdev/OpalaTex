# PDF Preview Zoom Bar — Theme Harmonization Fix

## Problem

The PDF preview zoom controls (buttons `+` and `-`) had poor visual contrast and were not harmonized with the application theme. In both light and dark themes, the zoom bar displayed:

- A **black background bar** regardless of the active theme.
- **Pure white magnifying glass icons** with `+`/`-` symbols in **light gray**, making them nearly invisible and aesthetically unpleasing.

This happened because the zoom controls were implemented with **hardcoded Tailwind classes** (e.g. `bg-slate-900/95`, `text-white`, `stroke="#f1f5f9"`) that ignored the application's theme system entirely.

---

## Root Cause

The application uses a **CSS variable-based theming system** defined in `gui_src/src/index.css`:

| Variable | Dark Theme (`:root`) | Light Theme (`.light-theme`) |
|---|---|---|
| `--vscode-sidebar-bg` | `#252526` | `#ebebeb` |
| `--vscode-editor-bg` | `#1e1e1e` | `#ffffff` |
| `--vscode-input-bg` | `#2d2d2d` | `#ffffff` |
| `--vscode-text-fg` | `#cccccc` | `#1e1e1e` |
| `--vscode-border` | `#3c3c3c` | `#c8c8c8` |
| `--vscode-button-bg` | `#0e639c` | `#005fb8` |

The theme is toggled by adding/removing the `light-theme` class on `document.body` (see `App.jsx`, line ~542):

```javascript
useEffect(() => {
  safeSetLocalStorage('theme', theme);
  if (theme === 'light') document.body.classList.add('light-theme');
  else document.body.classList.remove('light-theme');
}, [theme]);
```

The `PdfPreview` component was not using any of these variables — it used fixed Tailwind utility classes, so it never adapted to theme changes.

---

## Solution

### 1. Replace hardcoded Tailwind classes with CSS variables

All zoom control elements now use **inline `style` props referencing CSS variables**, ensuring automatic adaptation to the active theme.

**Before (hardcoded — broken):**
```jsx
<div className="absolute top-4 right-4 z-50 ... bg-slate-900/95 border border-slate-600">
  <button className="... bg-slate-700 hover:bg-blue-600 text-white">
    <svg stroke="#f1f5f9" ...>
```

**After (CSS variables — harmonized):**
```jsx
<div
  className="absolute top-4 right-4 z-50 flex items-center gap-1.5 rounded-lg shadow-lg p-1.5"
  style={{
    background: 'var(--vscode-sidebar-bg)',
    border: '1px solid var(--vscode-border)',
  }}
>
  <button
    className="flex items-center justify-center rounded-md transition-colors"
    style={{
      width: '32px',
      height: '32px',
      background: 'var(--vscode-input-bg)',
      border: '1px solid var(--vscode-border)',
      color: 'var(--vscode-text-fg)',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.background = 'var(--vscode-button-bg)';
      e.currentTarget.style.color = '#ffffff';
      e.currentTarget.style.borderColor = 'var(--vscode-button-bg)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = 'var(--vscode-input-bg)';
      e.currentTarget.style.color = 'var(--vscode-text-fg)';
      e.currentTarget.style.borderColor = 'var(--vscode-border)';
    }}
  >
    <svg stroke="currentColor" ...>
```

### 2. Use `currentColor` for SVG icons

The SVG icons now use `stroke="currentColor"` instead of a hardcoded color. This makes the icon inherit the button's `color` property, which is set to `var(--vscode-text-fg)`. This ensures:

- **Dark theme**: icons render in `#cccccc` (light gray on dark background — high contrast).
- **Light theme**: icons render in `#1e1e1e` (near-black on light background — high contrast).
- **Hover state**: icons turn white (`#ffffff`) when the button background switches to `var(--vscode-button-bg)` (blue).

### 3. Hover/leave event handlers

Since CSS variables can't be used directly in `:hover` pseudo-classes with inline styles, `onMouseEnter` and `onMouseLeave` handlers are used to swap the CSS variables on hover:

| State | Background | Text/Icon Color | Border |
|---|---|---|---|
| Normal | `var(--vscode-input-bg)` | `var(--vscode-text-fg)` | `var(--vscode-border)` |
| Hover | `var(--vscode-button-bg)` | `#ffffff` | `var(--vscode-button-bg)` |

### 4. Background and loading states harmonized

The PDF container background and the compiling overlay were also updated to use CSS variables:

```jsx
<div style={{ background: 'var(--vscode-editor-bg)' }}>
```

```jsx
<div style={{ background: 'var(--vscode-sidebar-bg)', color: 'var(--vscode-text-fg)' }}>
  <div style={{ borderColor: 'var(--vscode-active-border)' }} />
```

### 5. Removed unnecessary `theme` prop

The initial approach passed a `theme` prop from `EditorPanel.jsx` to `PdfPreview.jsx` and used conditional Tailwind classes. This was removed because CSS variables already handle theme switching automatically — no prop drilling needed.

---

## Files Modified

| File | Change |
|---|---|
| `gui_src/src/components/PdfPreview.jsx` | Replaced hardcoded Tailwind classes with CSS variable inline styles; removed `theme` prop and `isLightTheme` logic; harmonized background, loading overlay, and zoom controls. |
| `gui_src/src/components/EditorPanel.jsx` | Removed `theme={theme}` prop from both `<PdfPreview>` instances (no longer needed). |

---

## Key Takeaway

> **Always use the application's CSS variable system (`var(--vscode-*)`) for theming instead of hardcoded Tailwind classes or fixed hex colors.** This ensures UI components automatically adapt to the active theme (dark/light) without requiring conditional logic or prop drilling.

The CSS variables are defined in `gui_src/src/index.css` under `:root` (dark theme defaults) and `.light-theme` (light theme overrides). The theme is toggled by adding/removing the `light-theme` class on `document.body` in `App.jsx`.