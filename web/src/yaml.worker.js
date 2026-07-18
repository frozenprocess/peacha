// Vite worker entry for monaco-yaml. Importing the package's worker directly
// via `new URL('monaco-yaml/yaml.worker', import.meta.url)` trips Vite's
// "Unexpected usage" bug, so we re-export it from a project-local module and
// load THIS file with the `?worker` query instead (see monacoSetup.ts).
import 'monaco-yaml/yaml.worker';
