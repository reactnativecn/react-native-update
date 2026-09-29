import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { decodeNativeText } from '../../scripts/encode-native-text';

// JNI_OnLoad binds Android native methods from an encoded name/signature table
// (cpp/patch_core/jni_registration.cpp). A drifted entry would silently leave
// a method unbound until its first call, so the table must match every Java
// `native` declaration exactly.
const root = new URL('../../', import.meta.url);
const javaDir = 'android/src/main/java/cn/reactnative/modules/update/';
const javaPackage = 'cn/reactnative/modules/update/';

const descriptor = (type: string): string => {
  const array = type.endsWith('[]');
  const base = array ? type.slice(0, -2) : type;
  const primitives: Record<string, string> = {
    boolean: 'Z',
    int: 'I',
    long: 'J',
    double: 'D',
    float: 'F',
    void: 'V',
  };
  const element =
    primitives[base] ??
    (base === 'String' ? 'Ljava/lang/String;' : `L${javaPackage}${base};`);
  return array ? `[${element}` : element;
};

const javaNatives = () =>
  readdirSync(new URL(javaDir, root))
    .filter((file) => file.endsWith('.java'))
    .flatMap((file) => {
      const source = readFileSync(new URL(javaDir + file, root), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return [
        ...source.matchAll(/\bnative\s+([\w[\]]+)\s+(\w+)\s*\(([^)]*)\)\s*;/g),
      ].map((match) => {
        const params = match[3]
          .split(',')
          .map((param) => param.trim())
          .filter(Boolean)
          .map((param) => descriptor(param.split(/\s+/)[0]));
        return `${javaPackage}${file.replace('.java', '')}.${match[2]}${`(${params.join('')})`}${descriptor(match[1])}`;
      });
    })
    .sort();

const registered = () => {
  const source = readFileSync(
    new URL('cpp/patch_core/jni_registration.cpp', root),
    'utf8'
  );
  const entries: string[] = [];
  let currentClass = '';
  for (const match of source.matchAll(
    /\{"([0-9a-f]+)",\s*(?:\/\/[^\n]*)?\s*\{|\{"([0-9a-f]+)",\s*"([0-9a-f]+)",/g
  )) {
    if (match[1]) {
      currentClass = decodeNativeText(match[1]);
    } else {
      entries.push(
        `${currentClass}.${decodeNativeText(match[2])}${decodeNativeText(match[3])}`
      );
    }
  }
  return entries.sort();
};

describe('JNI registration table', () => {
  test('matches every Java native declaration', () => {
    const natives = javaNatives();
    expect(natives.length).toBe(11);
    expect(registered()).toEqual(natives);
  });

  test('stores no plain class or method names', () => {
    const source = readFileSync(
      new URL('cpp/patch_core/jni_registration.cpp', root),
      'utf8'
    ).replace(/\/\/.*$/gm, '');
    expect(source).not.toContain('cn/reactnative');
    expect(source).not.toMatch(/"[A-Za-z]{4,}"/);
  });
});
