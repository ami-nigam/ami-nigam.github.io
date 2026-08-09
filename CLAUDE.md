# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a GitHub Pages personal portfolio website for Ami Nigam (ami-nigam.com). The site is deployed automatically via GitHub Pages when changes are pushed to the main branch.

## Architecture

- **Single-column editorial layout**: One vertical scroll, content capped at 800px and centred. Sections are separated by hairline rules and use a two-column grid (label left, content right) that collapses to one column on mobile.
- **No build step**: `index.html` holds all markup and JavaScript inline; `styles.css` holds all styling. Edit and push.
- **Deployment**: GitHub Pages with custom domain configured via CNAME file.
- **Theme**: CSS custom properties-based light/dark mode with localStorage persistence.

## File Structure

```
/
├── CNAME                 # Custom domain configuration (ami-nigam.com)
├── index.html            # All markup + inline JavaScript
├── styles.css            # All custom CSS (variables, components, animations)
├── posts/
│   ├── index.json        # Array of post folder names to load
│   └── <post-slug>/
│       ├── post.json     # Post content and metadata
│       └── *.jpg         # Images referenced by post.json
├── prism-logo.png        # Currently unreferenced
└── ENHANCEMENT_PLAN.md   # Historical — describes a split-screen direction that was not built
```

## Page Structure

Top to bottom in `index.html`:

1. **Nav** — name, anchor links (About / Press / Thinking / Contact), theme toggle button
2. **Spectral line** — animated gradient rule, runs continuously (not scroll-triggered)
3. **Hero** — kicker, Playfair Display headline (bold line + italic line), body copy, affiliations
4. **About** — biography paragraphs; `.city` spans highlight place names in pink
5. **Press & Appearances** — hand-maintained list of `.press-item` entries (source, tag, title link, date)
6. **Thinking** — posts injected at runtime into `#thinking-posts` (see below)
7. **Contact** — single line linking to LinkedIn and a `mailto:hello@ami-nigam.com` link
8. **Footer** — copyright and a link out to PRISM Labs

## Thinking Section

`loadThinking()` merges two sources, sorts by date descending, and renders the **top 5**:

- **Authored posts** — `fetchAuthoredPosts()` reads `/posts/index.json`, then `/posts/<folder>/post.json` for each entry. Image filenames in `post.json` are resolved relative to the post folder.
- **LinkedIn RSS** — `fetchRSSPosts()` pulls an rss.app feed, falling back to the allorigins CORS proxy if the direct fetch fails. Items are kept only when `dc:creator` is "Ami Nigam" and the link contains the profile slug; `FILTER_TERMS` drops recruiting and job-ad posts.

Both sources are fetched with `Promise.allSettled`, so either can fail without breaking the section. If both return nothing, `STATIC_FALLBACK` renders instead.

### Adding an authored post

1. Create `/posts/<slug>/`
2. Add `post.json` with: `title`, `date` (YYYY-MM-DD), `source`, `url`, `headline` (optional), `text`, `images` (array of filenames)
3. Drop the images into the same folder
4. Add `<slug>` to the array in `/posts/index.json`
5. Push — it sorts into place by date automatically

## Other Behaviours

- **Theme toggle**: sets `data-theme="dark"` on `<html>` and persists to `localStorage.theme`. Light is the default; there is no system-preference detection.
- **Scroll animations**: an IntersectionObserver adds `.visible` to `.fade-up` elements, staggering `transition-delay` by 100ms per element within each section. Dynamically rendered posts are re-observed after render.
- **Link hover previews**: hovering an external link shows a floating Open Graph card (image, favicon, domain, title, description) built at runtime. Metadata is fetched through allorigins with a corsproxy.io fallback and cached per URL. Links inside `#thinking`, `.contact-line`, and `.footer-prism` are skipped.

## Technology Stack

- **Frontend**: HTML5, vanilla JavaScript, CSS Grid/Flexbox
- **Typography**: DM Sans (body, weights 300/400/500) and Playfair Display (headlines, incl. italic), loaded from Google Fonts
- **Styling**: Custom CSS with CSS variables. Note: the Tailwind CDN script is still loaded in `<head>` but no Tailwind utility classes are used in the markup — all styling comes from `styles.css`.
- **Animations**: CSS keyframes and transitions + Intersection Observer API
- **External services**: rss.app (LinkedIn feed), allorigins and corsproxy.io (CORS proxies), Google favicon service

## Development Notes

- **Build process**: None required — direct HTML/CSS editing
- **Deployment**: Automatic via GitHub Pages on main branch push
- **Local preview**: open `index.html` directly, but note that `/posts/` fetches use absolute paths and only resolve when served from a web root — serve the directory over HTTP to see the Thinking section populate
- **Responsive**: Two-column grid collapses at 640px; nav links hide at 480px
- **Accessibility**: `prefers-reduced-motion` disables the spectral animation and fade-ups, `:focus-visible` outlines, semantic HTML
- **Performance**: Lightweight, no bundler, images lazy-loaded
- **Theme management**: All colours flow from CSS custom properties on `:root` and `[data-theme="dark"]` — add new colours as variables rather than literals so both themes stay in sync
