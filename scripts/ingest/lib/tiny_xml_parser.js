'use strict';

/**
 * tiny_xml_parser.js — minimal, dependency-free XML → JS object parser.
 *
 * This repo has zero npm dependencies by design (no package-lock.json
 * entries, no node_modules) -- every other script here is pure Node. The
 * Equibase EntryRaceCard files (scripts/ingest/parse_equibase_pp.js) are
 * plain, well-formed XML with no CDATA, comments, namespaces, or mixed
 * content, so a small hand-rolled parser is enough; pulling in a real XML
 * library for this one need would break that convention for no real gain.
 *
 * Not a general-purpose XML parser: no DOCTYPE, no processing instructions
 * beyond the leading `<?xml ... ?>` declaration, no CDATA, no entity
 * decoding beyond the five XML predefined entities. Throws on anything it
 * doesn't understand rather than silently producing a wrong tree.
 *
 * Output shape: each element becomes { tag, attrs: {k:v}, children: [...] },
 * where children are either nested element objects or plain strings (text
 * nodes, already entity-decoded and NOT trimmed -- callers trim as needed).
 */

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(attrStr) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(attrStr))) {
    if (m[1] != null) attrs[m[1]] = decodeEntities(m[2]);
    else attrs[m[3]] = decodeEntities(m[4]);
  }
  return attrs;
}

/**
 * Parses an XML string into a single root element object.
 * @param {string} xml
 * @returns {{tag: string, attrs: Object, children: Array}}
 */
function parseXml(xml) {
  // Strip leading BOM, the <?xml ...?> declaration, and any stray leading
  // whitespace/comments before the root element.
  let s = xml.replace(/^﻿/, '').replace(/<\?xml[^>]*\?>/, '');

  const tagRe = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const stack = [{ tag: '#root', attrs: {}, children: [] }];
  let lastIndex = 0;
  let m;

  while ((m = tagRe.exec(s))) {
    const [full, closing, tag, attrStr, selfClose] = m;
    const textBefore = s.slice(lastIndex, m.index);
    if (textBefore && textBefore.trim().length) {
      stack[stack.length - 1].children.push(decodeEntities(textBefore));
    }
    lastIndex = m.index + full.length;

    if (closing) {
      if (stack.length < 2 || stack[stack.length - 1].tag !== tag) {
        throw new Error(`tiny_xml_parser: mismatched closing tag </${tag}> at offset ${m.index} (expected </${stack[stack.length - 1] && stack[stack.length - 1].tag}>)`);
      }
      stack.pop();
      continue;
    }

    const node = { tag, attrs: parseAttrs(attrStr || ''), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }

  if (stack.length !== 1) {
    throw new Error(`tiny_xml_parser: ${stack.length - 1} unclosed element(s) at end of document, innermost <${stack[stack.length - 1].tag}>`);
  }
  const root = stack[0].children.find(c => typeof c !== 'string');
  if (!root) throw new Error('tiny_xml_parser: no root element found');
  return root;
}

/** First direct child element with this tag name, or null. */
function child(el, tag) {
  if (!el || !el.children) return null;
  return el.children.find(c => typeof c !== 'string' && c.tag === tag) || null;
}

/** All direct child elements with this tag name. */
function children(el, tag) {
  if (!el || !el.children) return [];
  return el.children.filter(c => typeof c !== 'string' && c.tag === tag);
}

/** Concatenated text content of direct string children (trimmed), '' if none. */
function text(el) {
  if (!el || !el.children) return '';
  return el.children.filter(c => typeof c === 'string').join('').trim();
}

/** text() of the first direct child with this tag name, or null if the child doesn't exist. */
function childText(el, tag) {
  const c = child(el, tag);
  return c ? text(c) : null;
}

module.exports = { parseXml, child, children, text, childText };
