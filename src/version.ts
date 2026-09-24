// 构建时由 esbuild 的 define 注入；直接运行源码（测试）时回退为开发版本号。
declare const __VERSION__: string | undefined

export const VERSION: string = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev'
