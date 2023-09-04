/**
 * ## Barrel Optimizations
 *
 * This loader is used to optimize the imports of "barrel" files that have many
 * re-exports. Currently, both Node.js and Webpack have to enter all of these
 * submodules even if we only need a few of them.
 *
 * For example, say a file `foo.js` with the following contents:
 *
 *   export { a } from './a'
 *   export { b } from './b'
 *   export { c } from './c'
 *   ...
 *
 * If the user imports `a` only, this loader will accept the `names` option to
 * be `['a']`. Then, it request the "__barrel_transform__" SWC transform to load
 * `foo.js` and receive the following output:
 *
 *   export const __next_private_export_map__ = '[["a","./a","a"],["b","./b","b"],["c","./c","c"],...]'
 *
 *   format: '["<imported identifier>", "<import path>", "<exported name>"]'
 *   e.g.: import { a as b } from './module-a' => '["b", "./module-a", "a"]'
 *
 * The export map, generated by SWC, is a JSON that represents the exports of
 * that module, their original file, and their original name (since you can do
 * `export { a as b }`).
 *
 * Then, this loader can safely remove all the exports that are not needed and
 * re-export the ones from `names`:
 *
 *   export { a } from './a'
 *
 * That's the basic situation and also the happy path.
 *
 *
 *
 * ## Wildcard Exports
 *
 * For wildcard exports (e.g. `export * from './a'`), it becomes a bit more complicated.
 * Say `foo.js` with the following contents:
 *
 *   export * from './a'
 *   export * from './b'
 *   export * from './c'
 *   ...
 *
 * If the user imports `bar` from it, SWC can never know which files are going to be
 * exporting `bar`. So, we have to keep all the wildcard exports and do the same
 * process recursively. This loader will return the following output:
 *
 *   export * from '__barrel_optimize__?names=bar&wildcard!=!./a'
 *   export * from '__barrel_optimize__?names=bar&wildcard!=!./b'
 *   export * from '__barrel_optimize__?names=bar&wildcard!=!./c'
 *   ...
 *
 * The "!=!" tells Webpack to use the same loader to process './a', './b', and './c'.
 * After the recursive process, the "inner loaders" will either return an empty string
 * or:
 *
 *   export * from './target'
 *
 * Where `target` is the file that exports `bar`.
 *
 *
 *
 * ## Non-Barrel Files
 *
 * If the file is not a barrel, we can't apply any optimizations. That's because
 * we can't easily remove things from the file. For example, say `foo.js` with:
 *
 *   const v = 1
 *   export function b () {
 *     return v
 *   }
 *
 * If the user imports `b` only, we can't remove the `const v = 1` even though
 * the file is side-effect free. In these caes, this loader will simply re-export
 * `foo.js`:
 *
 *   export * from './foo'
 *
 * Besides these cases, this loader also carefully handles the module cache so
 * SWC won't analyze the same file twice, and no instance of the same file will
 * be accidentally created as different instances.
 */

import type webpack from 'webpack'

const NextBarrelLoader = async function (
  this: webpack.LoaderContext<{
    names: string[]
    wildcard: boolean
  }>
) {
  this.async()
  const { names, wildcard } = this.getOptions()

  const source = await new Promise<string>((resolve, reject) => {
    this.loadModule(
      `__barrel_transform__${wildcard ? '?wildcard' : ''}!=!${
        this.resourcePath
      }`,
      (err, src) => {
        if (err) {
          reject(err)
        } else {
          resolve(src)
        }
      }
    )
  })

  const matches = source.match(
    /^([^]*)export const __next_private_export_map__ = ('[^']+'|"[^"]+")/
  )

  if (!matches) {
    // This file isn't a barrel and we can't apply any optimizations. Let's re-export everything.
    // Since this loader accepts `names` and the request is keyed with `names`, we can't simply
    // return the original source here. That will create these imports with different names as
    // different modules instances.
    this.callback(null, `export * from ${JSON.stringify(this.resourcePath)}`)
    return
  }

  const wildcardExports = [...source.matchAll(/export \* from "([^"]+)"/g)]

  // It needs to keep the prefix for comments and directives like "use client".
  const prefix = matches[1]

  const exportList = JSON.parse(matches[2].slice(1, -1)) as [
    string,
    string,
    string
  ][]
  const exportMap = new Map<string, [string, string]>()
  for (const [name, path, orig] of exportList) {
    exportMap.set(name, [path, orig])
  }

  let output = prefix
  let missedNames: string[] = []
  for (const name of names) {
    // If the name matches
    if (exportMap.has(name)) {
      const decl = exportMap.get(name)!

      // In the wildcard case, if the value is exported from another file, we
      // redirect to that file (decl[0]). Otherwise, export from the current
      // file itself (this.resourcePath).
      if (wildcard && !decl[0]) {
        // E.g. the file contains `export const a = 1`
        decl[0] = this.resourcePath
        decl[1] = name
      }

      if (decl[1] === '*') {
        output += `\nexport * as ${name} from ${JSON.stringify(decl[0])}`
      } else if (decl[1] === 'default') {
        output += `\nexport { default as ${name} } from ${JSON.stringify(
          decl[0]
        )}`
      } else if (decl[1] === name) {
        output += `\nexport { ${name} } from ${JSON.stringify(decl[0])}`
      } else {
        output += `\nexport { ${decl[1]} as ${name} } from ${JSON.stringify(
          decl[0]
        )}`
      }
    } else {
      missedNames.push(name)
    }
  }

  // These are from wildcard exports.
  if (missedNames.length > 0) {
    for (const match of wildcardExports) {
      const path = match[1]

      output += `\nexport * from ${JSON.stringify(
        path.replace('__PLACEHOLDER__', missedNames.join(',') + '&wildcard')
      )}`
    }
  }

  this.callback(null, output)
}

export default NextBarrelLoader