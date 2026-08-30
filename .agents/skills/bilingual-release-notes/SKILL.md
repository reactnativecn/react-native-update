---
name: bilingual-release-notes
description: Prepare, edit, or review GitHub Release notes for react-native-update. Use whenever publishing a release or changing release notes in this repository; every release note must provide equivalent English and Simplified Chinese content.
---

# Bilingual release notes

All GitHub Release notes in this repository must be bilingual.

## Required outcome

- Put the complete English notes under `## English`, followed by an equivalent Simplified Chinese translation under `## 中文`.
- Mirror headings, bullets, warnings, compatibility notes, migration instructions, issue/PR references, commands, identifiers, measurements, contributor credits, and changelog links across both languages. Do not replace one language with a summary of the other.
- Keep code spans, API names, platform names, filenames, manifest entries, environment variables, version numbers, and protocol/format names unchanged. Translate the surrounding explanation naturally rather than mechanically.
- Derive content from the actual tag comparison and merged changes. Preserve any accurate existing notes; fix omissions or inaccuracies before translating them.
- Clearly call out unpublished, superseded, withdrawn, or compatibility-sensitive versions in both languages when applicable.
- Before finishing, read the published release back from GitHub and verify that both language sections render completely and describe the same changes.

This skill defines release-note content only. Follow the repository's normal release workflow and existing authorization requirements for publishing or editing a GitHub Release.
