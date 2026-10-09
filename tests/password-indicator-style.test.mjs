import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';

test('shared password input preserves the native Caps Lock hint with fixed, centered geometry', () => {
  const css = postcss.parse(readFileSync('src/global.css', 'utf8'));
  const rules = [];
  css.walkRules(rule => {
    if (rule.selector.includes('::-webkit-caps-lock-indicator')) rules.push(rule);
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].selector, 'input[data-slot="input"][type="password"]::-webkit-caps-lock-indicator');
  const style = Object.fromEntries(rules[0].nodes.map(node => [node.prop, node.value]));
  assert.equal(style.width, '17px');assert.equal(style.height, style.width);
  assert.equal(style['max-width'], style.width);assert.equal(style['max-height'], style.height);
  assert.equal(style['align-self'], 'center');assert.equal(style.flex, 'none');
  assert.equal(style['object-fit'], 'contain');
  assert.equal(style.content, undefined);assert.equal(style.display, undefined);assert.equal(style.visibility, undefined);
});
