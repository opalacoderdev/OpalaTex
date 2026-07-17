import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const viewerDist = join(root, 'node_modules', 'pptx-react-viewer', 'dist');

async function patchFile(relativePath, patches) {
  const filePath = join(viewerDist, relativePath);
  let source = await readFile(filePath, 'utf8');
  let changed = false;

  for (const patch of patches) {
    if (source.includes(patch.patchedNeedle)) {
      continue;
    }
    if (!source.includes(patch.original)) {
      throw new Error(`Could not patch ${relativePath}: expected source block was not found.`);
    }
    source = source.replace(patch.original, patch.replacement);
    changed = true;
  }

  if (changed) {
    await writeFile(filePath, source, 'utf8');
  }
}

const placeholderTransformPatch = {
  patchedNeedle: 'const restoreMasterTransform = (target, masterSource) => {',
  original: `    return {
      shape: layoutContext.shape || masterContext.shape ? this.mergeXmlObjects(masterContext.shape, layoutContext.shape) : void 0,
      picture: layoutContext.picture || masterContext.picture ? this.mergeXmlObjects(masterContext.picture, layoutContext.picture) : void 0
    };`,
  replacement: `    const result = {
      shape: layoutContext.shape || masterContext.shape ? this.mergeXmlObjects(masterContext.shape, layoutContext.shape) : void 0,
      picture: layoutContext.picture || masterContext.picture ? this.mergeXmlObjects(masterContext.picture, layoutContext.picture) : void 0
    };
    const restoreMasterTransform = (target, masterSource) => {
      if (!target || target?.["p:spPr"]?.["a:xfrm"]) {
        return;
      }
      const masterSpPr = masterSource?.["p:spPr"];
      if (!masterSpPr?.["a:xfrm"]) {
        return;
      }
      const targetSpPr = target["p:spPr"];
      target["p:spPr"] = this.mergeXmlObjects(
        masterSpPr,
        targetSpPr && typeof targetSpPr === "object" && !Array.isArray(targetSpPr) ? targetSpPr : void 0
      );
    };
    restoreMasterTransform(result.shape, masterContext.shape);
    restoreMasterTransform(result.picture, masterContext.picture);
    return result;`,
};

const esmInspectorPatch = {
  patchedNeedle: 'const [isInspectorPaneOpen, setIsInspectorPaneOpen] = useState(false);',
  original: `  const [isInspectorPaneOpen, setIsInspectorPaneOpen] = useState(
    () => typeof window === "undefined" ? true : window.innerWidth >= 768
  );`,
  replacement: `  const [isInspectorPaneOpen, setIsInspectorPaneOpen] = useState(false);`,
};

const cjsInspectorPatch = {
  patchedNeedle: 'const [isInspectorPaneOpen, setIsInspectorPaneOpen] = React3.useState(false);',
  original: `  const [isInspectorPaneOpen, setIsInspectorPaneOpen] = React3.useState(
    () => typeof window === "undefined" ? true : window.innerWidth >= 768
  );`,
  replacement: `  const [isInspectorPaneOpen, setIsInspectorPaneOpen] = React3.useState(false);`,
};

await patchFile('chunk-3ZGCM6RC.mjs', [placeholderTransformPatch]);
await patchFile('chunk-AD3EAEY6.js', [placeholderTransformPatch]);
await patchFile('chunk-2C3XYEFM.mjs', [esmInspectorPatch]);
await patchFile('chunk-2YHX6IAW.js', [cjsInspectorPatch]);

console.log('pptx-react-viewer patches are applied.');
