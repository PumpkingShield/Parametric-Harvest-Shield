/**
 * Переносить згенеровані `anchor build` артефакти у `packages/anchor-client`.
 *
 * `target/` під ігнором, а клієнт має жити в git разом із програмою, яку він
 * кодує. Тому IDL комітиться — але не редагується: єдине джерело його вмісту
 * це `programs/pumpking`, і будь-яка ручна правка тут зникне на наступному
 * прогоні, тихо розійшовшись із програмою до того.
 *
 * Запуск: pnpm idl:sync (після `scripts/anchor-build.sh` у WSL)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'packages', 'anchor-client', 'src', 'idl')

const banner = [
  '/**',
  ' * ЗГЕНЕРОВАНО `pnpm idl:sync` з `target/` після `anchor build`. Не редагувати:',
  ' * джерело — `programs/pumpking`, ручна правка зникне на наступному прогоні.',
  ' */',
].join('\n')

const types = readFileSync(join(root, 'target', 'types', 'pumpking.ts'), 'utf8')
const json = JSON.parse(readFileSync(join(root, 'target', 'idl', 'pumpking.json'), 'utf8'))

/*
 * Дані беруться з `target/types`, а не з `target/idl`. Два файли того самого
 * збирання відрізняються регістром: json тримає імена як у Rust
 * (`deposit_capital`), типи — як у JS (`depositCapital`), і саме другу форму
 * очікує кодувальник Anchor. Тіло типу — валідний JSON, тож перетворення
 * робить сам `anchor build`, а не наш переказ його алгоритму.
 */
const body = types.match(/export type Pumpking = ([\s\S]*);\s*$/)
if (body === null) {
  throw new Error('target/types/pumpking.ts не має очікуваного `export type Pumpking = {…};`')
}

const idl = JSON.parse(body[1])
if (idl.address !== json.address) {
  throw new Error(`target/idl і target/types з різних збирань: ${json.address} ≠ ${idl.address}`)
}

writeFileSync(join(outDir, 'pumpking.ts'), `${banner}\n\n${types.trimStart()}`)

// Дані IDL живуть модулем, а не імпортом JSON: `@pumpking/worker` стартує через
// `node src/index.ts`, а імпорт JSON в ESM вимагає атрибута типу, який vite і
// node трактують по-різному. Анотація `Pumpking` тут ще й перевіряє самі дані —
// розбіжність між `target/idl` і `target/types` впаде на typecheck.
writeFileSync(
  join(outDir, 'idl.ts'),
  `${banner}\n\nimport type { Pumpking } from './pumpking.ts'\n\n` +
    `export const PUMPKING_IDL: Pumpking = ${JSON.stringify(idl, null, 2)}\n`,
)

const accounts = idl.accounts?.length ?? 0
console.log(`idl ${idl.address}: ${idl.instructions.length} інструкцій, ${accounts} акаунтів`)
