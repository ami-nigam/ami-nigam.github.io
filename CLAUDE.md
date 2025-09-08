# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a GitHub Pages personal portfolio website for Ami Nigam (ami-nigam.com). The site is deployed automatically via GitHub Pages when changes are pushed to the main branch.

## Architecture

- **Single-page application**: Built as a standalone HTML file with inline CSS (Tailwind) and JavaScript
- **Styling**: Uses Tailwind CSS via CDN for responsive design and utilities
- **Deployment**: GitHub Pages with custom domain configured via CNAME file
- **Theme**: Implements a simple light/dark mode toggle via vanilla JavaScript

## File Structure

```
/
├── CNAME           # Custom domain configuration (ami-nigam.com)
└── index.html      # Main website file containing all HTML, CSS, and JS
```

## Key Components

- **Header section**: Name, title, and company with responsive typography
- **About section**: Professional description with mixed font styling
- **Services grid**: 6-item responsive grid showcasing expertise areas
- **Fixed controls**: Top-right theme toggle and LinkedIn link
- **Theme system**: JavaScript-based toggle between light/dark modes

## Development Notes

- No build process required - direct HTML editing
- Changes are deployed automatically when pushed to main branch
- Tailwind classes are loaded via CDN (not processed locally)
- All interactions handled by vanilla JavaScript
- Site uses semantic HTML with accessibility considerations