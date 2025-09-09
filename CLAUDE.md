# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a GitHub Pages personal portfolio website for Ami Nigam (ami-nigam.com). The site is deployed automatically via GitHub Pages when changes are pushed to the main branch.

## Architecture

- **Split-screen application**: Two-column layout with portfolio content (left) and Prism Labs showcase (right)
- **Styling**: Combines Tailwind CSS via CDN with custom CSS variables and animations
- **Deployment**: GitHub Pages with custom domain configured via CNAME file
- **Theme**: CSS custom properties-based light/dark mode with localStorage persistence

## File Structure

```
/
├── CNAME           # Custom domain configuration (ami-nigam.com)
├── index.html      # Main website file with HTML structure and JavaScript
└── styles.css      # Custom CSS with variables, animations, and component styles
```

## Key Components

### Left Section - Portfolio Content
- **Header**: Large typography with mixed font styles (serif/sans-serif, italic/normal)
- **About**: Extensive description with highlighted technology keywords
- **Services grid**: 6-item responsive grid with hover effects and animations
- **Typography**: Uppercase styling throughout with varied font weights

### Right Section - Prism Labs
- **Brand alignment**: Matches exact styling from official Prism Labs website
- **Interactive showcase**: Mouse-responsive spectral gradient effects
- **Typography**: Inter font family with exact color system from source
- **Layout**: Vertically centered content linking to GitHub repository
- **Spectral effects**: "Human Intent" and "AI" text with dynamic color gradients

### Global Features
- **Split layout**: CSS Grid-based responsive layout (stacks on mobile)
- **Fixed controls**: Top-right theme toggle and LinkedIn link
- **Animations**: Intersection Observer-based fade-in and slide-up effects
- **Theme system**: CSS custom properties with smooth transitions
- **Mouse interactivity**: Spectral gradient system responds to cursor movement

## Technology Stack

- **Frontend**: HTML5, vanilla JavaScript, CSS Grid/Flexbox
- **Styling**: Tailwind CSS (CDN) + custom CSS with CSS variables
- **Animations**: CSS keyframes + Intersection Observer API
- **Theme**: CSS custom properties with localStorage persistence
- **Typography**: Mixed serif/sans-serif with extensive uppercase styling, Inter font for Prism Labs section
- **Interactive effects**: Mouse-responsive spectral gradients with CSS custom properties

## Development Notes

- **Build process**: None required - direct HTML/CSS editing
- **Deployment**: Automatic via GitHub Pages on main branch push
- **Responsive**: Mobile-first with CSS Grid breakpoints
- **Accessibility**: Reduced motion preferences, focus states, semantic HTML
- **Performance**: Lightweight with minimal dependencies (only Tailwind CDN)
- **Theme management**: CSS custom properties for consistent theming across components