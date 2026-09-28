// .ts/.tsx 를 ReactJSX 로 변환해 node --test 에서 그대로 import 하게 하는 로더(Design §8.5, tests/shell-tabs.test.mjs).
// *.css 는 빈 모듈, 'server-only' 는 스텁이다. 확장자 없는 상대 import 는 .ts → .tsx 순서로 찾는다.
// 새 devDependency 없이 typescript 의 transpileModule 만 쓴다(타입 검사는 하지 않는다).
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'tsx-test:server-only', shortCircuit: true };
    if (specifier.endsWith('.css')) return { url: `tsx-test:css:${specifier}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url)) {
        for (const extension of ['.ts', '.tsx']) {
          if (existsSync(new URL(`${url.href}${extension}`))) return nextResolve(`${url.href}${extension}`, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('tsx-test:')) return { format: 'module', source: url.startsWith('tsx-test:css:') ? 'export default {};' : 'export {};', shortCircuit: true };
    if (url.startsWith('file:') && (url.endsWith('.ts') || url.endsWith('.tsx'))) {
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          fileName: fileURLToPath(url),
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});
