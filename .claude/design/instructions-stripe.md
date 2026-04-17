# Stripe Design System -- Implementation Instructions for PAY.JP x Discord Frontend

Target: `frontend/member.html` (external CSS via `/src/member-page.css`) + vanilla TypeScript SPA (Vite) mounted at `/member`
Language: Japanese UI (lang="ja")

---

## 1. Font Stack (sohne-var Fallback Strategy)

sohne-var is proprietary. Use Inter (Latin) + Noto Sans JP (Japanese) as the closest open-source substitute. The current Google Fonts import already loads both.

```css
:root {
  --font-sans: Inter, 'Noto Sans JP', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'SFMono-Regular', monospace;
}
```

Google Fonts import (already in place -- keep weights 300, 400, 500):
```
Inter:wght@300;400;500
Noto Sans JP:wght@300;400;500
JetBrains Mono:wght@400
```

**No changes needed** to the current font imports. Inter reproduces the geometric, modern feel of sohne-var at the weights Stripe uses (300, 400).

---

## 2. Color Palette (CSS Custom Properties)

### Current state: Already correct
All of the following are already defined in `index.html :root` and match the Stripe spec. No changes needed.

| Variable | Hex | Role |
|---|---|---|
| `--color-primary` | `#533afd` | CTA backgrounds, links, interactive highlights |
| `--color-primary-hover` | `#4434d4` | Hover state for primary buttons |
| `--color-heading` | `#061b31` | Deep navy headings (never pure black) |
| `--color-body` | `#64748d` | Secondary text, descriptions |
| `--color-label` | `#273951` | Form labels, secondary headings |
| `--color-bg` | `#ffffff` | Page background, card surfaces |
| `--color-border` | `#e5edf5` | Card borders, dividers, input borders |
| `--color-success` | `#15be53` | Status indicators |
| `--color-success-bg` | `rgba(21,190,83,0.2)` | Success badge background |
| `--color-success-text` | `#108c3d` | Success badge text |
| `--color-error` | `#ea2261` | Error text, destructive actions (Stripe Ruby) |
| `--color-error-bg` | `rgba(234,34,97,0.08)` | Error banner background |
| `--color-error-border` | `rgba(234,34,97,0.2)` | Error banner border |

### Missing variables to add

```css
:root {
  /* --- Add these to existing :root block --- */
  --color-brand-dark: #1c1e54;        /* Dark section backgrounds */
  --color-purple-light: #b9b9f9;      /* Ghost button border, subdued hover */
  --color-border-soft-purple: #d6d9fc; /* Subtle purple-tinted borders */
  --color-lemon: #9b6829;             /* Warning accent (already used inline in warning-banner) */

  /* Shadow tokens */
  --shadow-elevated: rgba(50,50,93,0.25) 0px 30px 45px -30px, rgba(0,0,0,0.1) 0px 18px 36px -18px;
  --shadow-button: rgba(50,50,93,0.25) 0px 6px 12px -2px, rgba(0,0,0,0.1) 0px 3px 7px -3px;
  --shadow-ambient: rgba(23,23,23,0.08) 0px 15px 35px 0px;
  --shadow-modal: rgba(50,50,93,0.25) 0px 50px 100px -20px, rgba(0,0,0,0.3) 0px 30px 60px -30px;
}
```

### Discord brand colors
The Discord-specific colors (`--color-discord-blurple`, etc.) are project-specific and NOT part of Stripe's palette. Keep them as-is. They are used only for the Discord OAuth button.

---

## 3. Typography Rules

### 3.1 Weight convention
- **Weight 300**: Default for ALL headings and body text. This is Stripe's signature -- light weight conveys quiet authority.
- **Weight 400**: Used ONLY for buttons, links, navigation, form labels, and small UI text.
- **Weight 500**: Used ONLY for section headings that need emphasis (`.heading`, `.form-section-title`). This is a deviation from pure Stripe (which uses 300 for headings), but acceptable for a Japanese UI where 300-weight kanji can feel too thin.

### 3.2 Changes needed

| Class | Current | Stripe-aligned target | Action |
|---|---|---|---|
| `.heading` | `font-weight: 500` | Keep 500 | No change (Japanese readability) |
| `.body-text` | `font-weight: 300` | 300 | Already correct |
| `.plan-card-price` | `font-weight: 300; letter-spacing: -0.64px` | 300, -0.64px | Already correct |
| `.success-heading` | `font-weight: 300` | 300 | Already correct |

### 3.3 Letter-spacing scale (apply to headings)
```css
/* Display sizes get negative tracking */
/* 32px+ headings: -0.64px */
/* 26px headings: -0.26px */
/* 22px headings: -0.22px */
/* 16px and below: normal */
```

### 3.4 Additions

Add `letter-spacing` to `.heading` (20px):
```css
.heading {
  letter-spacing: -0.2px;  /* Proportional to 20px */
}
```

Add `letter-spacing` to `.success-heading` (26px):
```css
.success-heading {
  letter-spacing: -0.26px;
}
```

Add `letter-spacing` to `.subscribed-plan-name` (22px):
```css
.subscribed-plan-name {
  letter-spacing: -0.22px;
}
```

Add `letter-spacing` to `.modal-title` (20px):
```css
.modal-title {
  letter-spacing: -0.2px;
}
```

### 3.5 font-feature-settings

Since Inter (not sohne-var) is used, `"ss01"` does not apply. However, Inter has its own useful OpenType features. Apply `"tnum"` for tabular numerals on financial data:

```css
.plan-card-price,
.result-value,
.operation-id-value {
  font-feature-settings: "tnum";
}
```

---

## 4. Component Alignment

### 4.1 Buttons -- Already correct
All button classes (`.submit-button`, `.discord-button`, `.secondary-button`, `.cancel-button`, `.ghost-neutral-button`) already match Stripe conventions:
- 4px radius
- `rgba(50,50,93,0.25)` blue-tinted shadows on primary buttons
- Proper hover transitions

### 4.2 Secondary button border -- Needs alignment

Current `.secondary-button` uses `border: 1px solid var(--color-border)` (neutral). Stripe's ghost/outlined button uses `1px solid #b9b9f9` (purple-tinted border):

```css
.secondary-button {
  border: 1px solid var(--color-purple-light);  /* Was: var(--color-border) */
  color: var(--color-primary);  /* Already correct */
}
.secondary-button:hover {
  border-color: var(--color-primary);  /* Was: var(--color-primary), already correct */
  background: rgba(83, 58, 253, 0.05);  /* Add: subtle purple hover bg */
}
```

### 4.3 Cards -- Already correct
- `.card`: 6px radius, `#e5edf5` border, blue-tinted dual-layer shadow. Matches Stripe Level 3 elevation.
- `.modal`: 8px radius, deeper shadow. Matches Stripe large/featured treatment.

### 4.4 Badges -- Partial alignment needed

Status badge (`.status-badge`) is correct. Success badge (`.success-badge`) currently uses Discord green colors. To align with Stripe:

```css
.success-badge {
  background: var(--color-success-bg);        /* Was: rgba(87,242,135,0.2) */
  border: 1px solid rgba(21,190,83,0.4);      /* Was: 1px solid var(--color-discord-green) */
  color: var(--color-success-text);            /* Was: var(--color-heading) */
}
.success-icon {
  color: var(--color-success);                 /* Was: var(--color-discord-green) */
}
```

### 4.5 Form inputs -- Already correct
- 4px radius, `#e5edf5` border, focus ring with `var(--color-primary)`
- Label color `var(--color-label)` = `#273951`
- All matches Stripe spec

### 4.6 Cancel info card -- Already correct
- Uses `rgba(83,58,253,0.04)` background with `#d6d9fc` border (Stripe's soft purple)

---

## 5. Shadow System (Elevation Levels)

### Reference table -- use shadow tokens

| Level | Token | Value | Use in project |
|---|---|---|---|
| Level 0 (Flat) | none | none | Inline text, backgrounds |
| Level 1 (Ambient) | -- | `rgba(23,23,23,0.06) 0px 3px 6px` | Subtle hover hints (not currently used) |
| Level 2 (Standard) | `--shadow-ambient` | `rgba(23,23,23,0.08) 0px 15px 35px` | Standard panels |
| Level 3 (Elevated) | `--shadow-elevated` | `rgba(50,50,93,0.25) 0px 30px 45px -30px, rgba(0,0,0,0.1) 0px 18px 36px -18px` | `.card` (already applied) |
| Level 3.5 (Button) | `--shadow-button` | `rgba(50,50,93,0.25) 0px 6px 12px -2px, rgba(0,0,0,0.1) 0px 3px 7px -3px` | `.submit-button`, `.discord-button` (already applied) |
| Level 4 (Modal) | `--shadow-modal` | `rgba(50,50,93,0.25) 0px 50px 100px -20px, rgba(0,0,0,0.3) 0px 30px 60px -30px` | `.modal` (already applied) |

### Key principle
All shadows use `rgba(50,50,93,0.25)` as the primary layer -- this is Stripe's signature blue-tinted shadow. NEVER use neutral gray shadows. The current implementation already follows this correctly.

---

## 6. Layout

### Already correct
- Max width: 720px (close to Stripe's ~1080px but appropriate for a single-card payment flow)
- 8px base spacing unit
- Plan grid: 3-column on desktop, 1-column on mobile (640px breakpoint)
- Card padding: 32px 24px
- Body padding: 40px 24px

### Border-radius scale (current usage is correct)
- 3px: Checkbox, copy button
- 4px: Buttons, inputs, badges, error banners, operation-id box
- 6px: Cards, plan cards, result details, cancel info card
- 8px: Modal
- 50%: Success icon circle, spinner

All within Stripe's 4px-8px range for rectangular elements.

---

## 7. Responsive Behavior

### Current breakpoint: 640px -- matches Stripe's mobile breakpoint

Existing responsive rules are correct:
- Plan grid collapses to single column
- Price font shrinks from 32px to 26px
- Container narrows to 480px max

### Add tablet breakpoint (optional enhancement)

```css
@media (max-width: 768px) and (min-width: 641px) {
  .plan-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
```

### Accessibility -- Already correct
- `prefers-reduced-motion` handler disables all transitions and spinner animation
- Focus-visible outlines use `2px solid var(--color-primary)` with `outline-offset: 2px` (matches Stripe's Ring level)

---

## 8. Stripe Design Rules (Do's and Don'ts for this project)

### Do
- Use `#061b31` (deep navy) for ALL heading text -- never `#000000`
- Use `rgba(50,50,93,0.25)` as the primary shadow color -- blue-tinted shadows are the brand signature
- Keep border-radius between 3px-8px -- no pills, no 12px+ rounding
- Use weight 300 for body text and large display text
- Use weight 400-500 for buttons and UI controls
- Use `font-feature-settings: "tnum"` on price displays and financial data
- Apply negative letter-spacing on text 20px and above (proportional to size)
- Keep the Discord button's Blurple color -- it is a brand requirement separate from Stripe's palette

### Don't
- Don't use pure black (`#000000`) for text -- always deep navy (`#061b31`) for headings, slate (`#64748d`) for body
- Don't use neutral gray shadows -- always blue-tinted (`rgba(50,50,93,...)`)
- Don't use border-radius larger than 8px on rectangular elements
- Don't use weight 600-700 on Inter/Noto Sans JP for headings
- Don't use warm accent colors (orange, yellow) for interactive elements
- Don't use `#ea2261` (Ruby/error) for buttons or links -- it is for error states and decorative use only
- Don't add positive letter-spacing to headings

---

## 9. Gap Analysis: What to Change

### Priority 1 (Alignment corrections)

1. **Add missing CSS custom properties** (Section 2: `--color-purple-light`, `--color-border-soft-purple`, shadow tokens)
2. **Fix `.secondary-button` border** to use `--color-purple-light` instead of `--color-border` (Section 4.2)
3. **Fix `.success-badge` colors** to use Stripe success palette instead of Discord green (Section 4.4)
4. **Add `letter-spacing`** to `.heading`, `.success-heading`, `.subscribed-plan-name`, `.modal-title` (Section 3.4)
5. **Add `font-feature-settings: "tnum"`** to price and financial data elements (Section 3.5)

### Priority 2 (Enhancements)

6. **Add tablet breakpoint** for 2-column plan grid between 641px-768px (Section 7)
7. **Add secondary button hover background** `rgba(83,58,253,0.05)` (Section 4.2)

### Not needed (already correct)

- Color palette (all Stripe hex values match)
- Card shadows (blue-tinted dual-layer)
- Modal shadows (deeper variant)
- Button shadows (compact dual-layer)
- Border-radius scale (3px-8px range)
- Font weights (300 body, 400-500 UI)
- Body line-height (1.6 -- slightly above Stripe's 1.4, acceptable for Japanese text)
- Focus-visible outlines (2px solid primary)
- Reduced-motion handling
- Responsive mobile breakpoint (640px)

---

## 10. CSS Patch (apply all Priority 1 + 2 changes)

```css
/* --- In :root, ADD after existing variables --- */
--color-purple-light: #b9b9f9;
--color-border-soft-purple: #d6d9fc;
--shadow-elevated: rgba(50,50,93,0.25) 0px 30px 45px -30px, rgba(0,0,0,0.1) 0px 18px 36px -18px;
--shadow-button: rgba(50,50,93,0.25) 0px 6px 12px -2px, rgba(0,0,0,0.1) 0px 3px 7px -3px;
--shadow-modal: rgba(50,50,93,0.25) 0px 50px 100px -20px, rgba(0,0,0,0.3) 0px 30px 60px -30px;

/* --- MODIFY .heading --- */
.heading {
  /* existing properties unchanged */
  letter-spacing: -0.2px;  /* ADD */
}

/* --- MODIFY .success-heading --- */
.success-heading {
  /* existing properties unchanged */
  letter-spacing: -0.26px;  /* ADD */
}

/* --- MODIFY .subscribed-plan-name --- */
.subscribed-plan-name {
  /* existing properties unchanged */
  letter-spacing: -0.22px;  /* ADD */
}

/* --- MODIFY .modal-title --- */
.modal-title {
  /* existing properties unchanged */
  letter-spacing: -0.2px;  /* ADD */
}

/* --- ADD font-feature-settings for financial data --- */
.plan-card-price,
.result-value,
.operation-id-value {
  font-feature-settings: "tnum";
}

/* --- MODIFY .success-badge --- */
.success-badge {
  background: var(--color-success-bg);
  border: 1px solid rgba(21, 190, 83, 0.4);
  color: var(--color-success-text);
}
.success-icon {
  color: var(--color-success);
}

/* --- MODIFY .secondary-button --- */
.secondary-button {
  border: 1px solid var(--color-purple-light);  /* Was: var(--color-border) */
}
.secondary-button:hover {
  border-color: var(--color-primary);
  background: rgba(83, 58, 253, 0.05);  /* ADD */
}

/* --- ADD tablet breakpoint --- */
@media (max-width: 768px) and (min-width: 641px) {
  .plan-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
```
