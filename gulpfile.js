/**
 @author : Caven Chen
 **/

'use strict'

import fse from 'fs-extra'
import path from 'path'
import gulp from 'gulp'
import esbuild from 'esbuild'
import concat from 'gulp-concat'
import { rollup } from 'rollup'
import clean from 'gulp-clean'
import commonjs from '@rollup/plugin-commonjs'
import resolve from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'
import scss from 'rollup-plugin-scss'
import javascriptObfuscator from 'gulp-javascript-obfuscator'
import { babel } from '@rollup/plugin-babel'
import startServer from './server.js'
import inlineImage from 'esbuild-plugin-inline-image'
import { glsl } from 'esbuild-plugin-glsl'
import chokidar from 'chokidar'
import shell from 'shelljs'
import chalk from 'chalk'

const obfuscatorConfig = {
  compact: true, //压缩代码
  identifierNamesGenerator: 'hexadecimal', //标识符的混淆方式 hexadecimal(十六进制) mangled(短标识符)
  renameGlobals: false, //是否启用全局变量和函数名称的混淆
  rotateStringArray: true, //通过固定和随机（在代码混淆时生成）的位置移动数组。这使得将删除的字符串的顺序与其原始位置相匹配变得更加困难。如果原始源代码不小，建议使用此选项，因为辅助函数可以引起注意。
  selfDefending: true, //混淆后的代码,不能使用代码美化,同时需要配置 compact:true;
  stringArray: true, //删除字符串文字并将它们放在一个特殊的数组中
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  transformObjectKeys: false,
  unicodeEscapeSequence: false, //允许启用/禁用字符串转换为unicode转义序列。Unicode转义序列大大增加了代码大小，并且可以轻松地将字符串恢复为原始视图。建议仅对小型源代码启用此选项。
}

const buildConfig = {
  entryPoints: ['src/DC.js'],
  bundle: true,
  color: true,
  legalComments: `inline`,
  logLimit: 0,
  target: `es2019`,
  minify: false,
  sourcemap: false,
  write: true,
  logLevel: 'info',
  external: [`http`, `https`, `url`, `zlib`],
  plugins: [
    inlineImage({
      limit: -1,
    }),
    glsl(),
  ],
}

const packageJson = fse.readJsonSync('./package.json')

const plugins = [
  resolve({ preferBuiltins: true }),
  commonjs(),
  babel({
    babelHelpers: 'runtime',
    presets: [
      [
        '@babel/preset-env',
        {
          modules: false,
          targets: {
            browsers: ['> 1%', 'last 2 versions', 'ie >= 10'],
          },
        },
      ],
    ],
    plugins: ['@babel/plugin-transform-runtime'],
  }),
]

function getTime() {
  let now = new Date()
  let m = now.getMonth() + 1
  m = m < 10 ? '0' + m : m
  let d = now.getDate()
  d = d < 10 ? '0' + d : d
  return `${now.getFullYear()}-${m}-${d}`
}

async function buildNamespace(options) {
  const bundle = await rollup({
    input: 'libs/index.js',
    plugins: [...plugins, ...[options.dev ? null : terser()]],
    onwarn: (message) => {
      // Ignore eval warnings in third-party code we don't have control over
      if (message.code === 'EVAL' && /protobufjs/.test(message.loc.file)) {
        return
      }
      if (message.code === 'CIRCULAR_DEPENDENCY') {
        return
      }
      console.log(message)
    },
  })
  return bundle.write({
    name: 'DC.__namespace',
    file: options.node ? 'dist/namespace.cjs' : 'dist/namespace.js',
    format: options.node ? 'cjs' : 'umd',
    sourcemap: false,
    banner: options.node ? '(function(){' : '',
    footer: options.node ? '})()' : '',
  })
}

async function buildCSS() {
  const bundle = await rollup({
    input: 'src/themes/index.js',
    plugins: [
      commonjs(),
      resolve({ preferBuiltins: true }),
      scss({
        outputStyle: 'compressed',
        fileName: 'dc.min.css',
      }),
    ],
  })
  return bundle.write({
    file: 'dist/dc.min.css',
  })
}

async function buildModules(options) {
  const dcPath = path.join('src', 'DC.js')

  const content = await fse.readFile(path.join('src', 'index.js'), 'utf8')

  await fse.ensureFile(dcPath)

  const exportVersion = `export const VERSION = '${packageJson.version}'`

  const cmdOut_content = await fse.readFile(
    path.join('src', 'copyright', 'cmdOut.js'),
    'utf8'
  )

  const exportCmdOut = `
        export function __cmdOut() {
          ${cmdOut_content
            .replace('{{__VERSION__}}', packageJson.version)
            .replace('{{__TIME__}}', getTime())
            .replace(
              '{{__ENGINE_VERSION__}}',
              packageJson.devDependencies['@cesium/engine'].replace('^', '')
            )
            .replace('{{__AUTHOR__}}', packageJson.author)
            .replace('{{__HOME_PAGE__}}', packageJson.homepage)
            .replace('{{__REPOSITORY__}}', packageJson.repository)}
    }`

  const exportNamespace = `
        export const __namespace = {
            Cesium: exports.Cesium,
            Supercluster: exports.Supercluster
        }
     `

  // Build IIFE
  if (options.iife) {
    await fse.outputFile(
      dcPath,
      `
              ${exportVersion}
              ${exportCmdOut}
              ${content}

            `,
      {
        encoding: 'utf8',
      }
    )
    await esbuild.build({
      ...buildConfig,
      format: 'iife',
      globalName: 'DC',
      outfile: path.join('dist', 'modules.js'),
    })
  }

  // Build Node、
  if (options.node) {
    await fse.outputFile(
      dcPath,
      `
            ${exportNamespace}
            ${exportVersion}
            ${exportCmdOut}
            ${content}
            `,
      {
        encoding: 'utf8',
      }
    )
    await esbuild.build({
      ...buildConfig,
      format: 'cjs',
      platform: 'node',
      define: {
        TransformStream: 'null',
      },
      outfile: path.join('dist', 'modules.cjs'),
    })
  }

  // remove DC.js
  await fse.remove(dcPath)
}

async function combineJs(options) {
  // combine for iife
  if (options.iife) {
    if (options.obfuscate) {
      await gulp
        .src('dist/modules.js')
        .pipe(javascriptObfuscator(obfuscatorConfig))
        .pipe(gulp.src('dist/namespace.js'))
        .pipe(concat('dc.min.js'))
        .pipe(gulp.dest('dist'))
        .on('end', () => {
          addCopyright(options)
          deleteTempFile(options)
        })
    } else {
      await gulp
        .src(['dist/modules.js', 'dist/namespace.js'])
        .pipe(concat('dc.min.js'))
        .pipe(gulp.dest('dist'))
        .on('end', () => {
          addCopyright(options)
          deleteTempFile(options)
        })
    }
  }

  // combine for node
  if (options.node) {
    if (options.obfuscate) {
      await gulp
        .src('dist/modules.cjs')
        .pipe(javascriptObfuscator(obfuscatorConfig))
        .pipe(gulp.dest('dist'))
        .on('end', async () => {
          await gulp
            .src(['dist/namespace.cjs', 'dist/modules.cjs'])
            .pipe(concat('index.cjs'))
            .pipe(gulp.dest('dist'))
            .on('end', () => {
              addCopyright(options)
              deleteTempFile(options)
            })
        })
    } else {
      await gulp
        .src(['dist/namespace.cjs', 'dist/modules.cjs'])
        .pipe(concat('index.cjs'))
        .pipe(gulp.dest('dist'))
        .on('end', () => {
          addCopyright(options)
          deleteTempFile(options)
        })
    }
  }
}

async function copyAssets() {
  await fse.emptyDir('dist/resources')
  await gulp
    .src('./node_modules/@cesium/engine/Build/Workers/**', { nodir: true })
    .pipe(gulp.dest('dist/resources/Workers'))
  await gulp
    .src('./node_modules/@cesium/engine/Source/Assets/**', { nodir: true })
    .pipe(gulp.dest('dist/resources/Assets'))
  await gulp
    .src('./node_modules/@cesium/engine/Source/ThirdParty/**', { nodir: true })
    .pipe(gulp.dest('dist/resources/ThirdParty'))
}

async function addCopyright(options) {
  let header = await fse.readFile(
    path.join('src', 'copyright', 'header.js'),
    'utf8'
  )
  header = header
    .replace('{{__VERSION__}}', packageJson.version)
    .replace('{{__AUTHOR__}}', packageJson.author)
    .replace('{{__REPOSITORY__}}', packageJson.repository)

  if (options.iife) {
    let filePath = path.join('dist', 'dc.min.js')
    const content = await fse.readFile(filePath, 'utf8')
    await fse.outputFile(filePath, `${header}${content}`, { encoding: 'utf8' })
  }

  if (options.node) {
    let filePath = path.join('dist', 'index.cjs')
    const content = await fse.readFile(filePath, 'utf8')
    await fse.outputFile(filePath, `${header}${content}`, { encoding: 'utf8' })
  }
}

async function deleteTempFile(options) {
  if (options.iife) {
    await gulp
      .src(['dist/namespace.js', 'dist/modules.js'], { read: false })
      .pipe(clean())
  }

  if (options.node) {
    await gulp
      .src(['dist/namespace.cjs', 'dist/modules.cjs'], { read: false })
      .pipe(clean())
  }
}

async function regenerate(option, content) {
  await fse.remove('dist/dc.min.js')
  await fse.remove('dist/dc.min.css')
  await fse.outputFile(path.join('dist', 'namespace.js'), content)
  await buildModules(option)
  await combineJs(option)
  await buildCSS()
}

export const server = gulp.series(startServer)

export const dev = gulp.series(
  () => buildNamespace({ dev: true }),
  copyAssets,
  () => {
    shell.echo(chalk.yellow('============= start dev =============='))
    const watcher = chokidar.watch('src', {
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    })
    fse.readFile(path.join('dist', 'namespace.js'), 'utf8').then((content) => {
      watcher
        .on('ready', async () => {
          await regenerate({ iife: true }, content)
          await startServer()
        })
        .on('change', async () => {
          let now = new Date()
          await regenerate({ iife: true }, content)
          shell.echo(
            chalk.green(
              `regenerate lib takes ${new Date().getTime() - now.getTime()} ms`
            )
          )
        })
    })
    return watcher
  }
)

export const buildNode = gulp.series(
  () => buildNamespace({ node: true }),
  () => buildModules({ node: true }),
  () => combineJs({ node: true }),
  buildCSS,
  copyAssets
)

export const buildIIFE = gulp.series(
  () => buildNamespace({ iife: true }),
  () => buildModules({ iife: true }),
  () => combineJs({ iife: true }),
  buildCSS,
  copyAssets
)

export const build = gulp.series(
  () => buildNamespace({ node: true }),
  () => buildModules({ node: true }),
  () => combineJs({ node: true }),
  () => buildNamespace({ iife: true }),
  () => buildModules({ iife: true }),
  () => combineJs({ iife: true }),
  buildCSS,
  copyAssets
)

export const buildRelease = gulp.series(
  () => buildNamespace({ node: true }),
  () => buildModules({ node: true }),
  () => combineJs({ node: true, obfuscate: true }),
  () => buildNamespace({ iife: true }),
  () => buildModules({ iife: true }),
  () => combineJs({ iife: true, obfuscate: true }),
  buildCSS,
  copyAssets
)
