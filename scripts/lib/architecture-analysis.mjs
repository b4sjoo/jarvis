import fs from "node:fs";
import path from "node:path";
import tsModule from "typescript";
import { validateDeletionLedger } from "./maintainability-deletion-ledger.mjs";

const ts = tsModule.default ?? tsModule;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const RUST_EXTENSION = ".rs";

export function discoverArchitecture(repositoryRoot = process.cwd()) {
  const sourceRoot = path.join(repositoryRoot, "src");
  const rustRoot = path.join(repositoryRoot, "src-tauri", "src");
  const sourceFiles = walkFiles(sourceRoot, SOURCE_EXTENSIONS);
  const rustFiles = walkFiles(rustRoot, new Set([RUST_EXTENSION]));
  const sourceFileSet = new Set(sourceFiles.map((file) => path.resolve(file)));

  const imports = [];
  const taskMutationCalls = [];
  const frontendInvokes = [];
  const wrappedFrontendInvokes = [];
  const frontendListens = [];
  const frontendEmits = [];
  const dynamicFrontendInvokes = [];
  const dynamicFrontendListens = [];
  const dynamicFrontendEmits = [];

  const parsedSources = new Map(
    sourceFiles.map((absoluteFile) => {
      const sourceText = fs.readFileSync(absoluteFile, "utf8");
      return [
        absoluteFile,
        ts.createSourceFile(
          absoluteFile,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          absoluteFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        ),
      ];
    })
  );
  const exportedStringConstants = collectExportedStringConstants(
    parsedSources,
    repositoryRoot,
    sourceFileSet
  );

  for (const absoluteFile of sourceFiles) {
    const relativeFile = relative(repositoryRoot, absoluteFile);
    const sourceFile = parsedSources.get(absoluteFile);
    const staticStrings = collectStaticStringBindings(
      sourceFile,
      absoluteFile,
      repositoryRoot,
      sourceFileSet,
      exportedStringConstants
    );
    const tauriBindings = collectTauriBindings(sourceFile);

    for (const statement of sourceFile.statements) {
      if (
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier.text;
        imports.push({
          file: relativeFile,
          specifier,
          resolved: resolveSourceImport(
            repositoryRoot,
            absoluteFile,
            specifier,
            sourceFileSet
          ),
        });
      }
    }

    visit(sourceFile, (node) => {
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        imports.push({
          file: relativeFile,
          specifier: node.argument.literal.text,
          resolved: resolveSourceImport(
            repositoryRoot,
            absoluteFile,
            node.argument.literal.text,
            sourceFileSet
          ),
        });
      }
      if (!ts.isCallExpression(node)) return;
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        const specifier = node.arguments[0] && ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0].text
          : "<computed-module>";
        imports.push({
          file: relativeFile,
          specifier,
          resolved: resolveSourceImport(repositoryRoot, absoluteFile, specifier, sourceFileSet),
        });
      }
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      const callsite = {
        file: relativeFile,
        line: location.line + 1,
      };
      const firstArgument = node.arguments[0];

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        TASK_MUTATION_METHODS.has(node.expression.name.text)
      ) {
        taskMutationCalls.push({
          ...callsite,
          method: node.expression.name.text,
        });
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "invokeCommand" ||
          node.expression.name.text === "invoke")
      ) {
        collectLiteralOrDynamic(
          firstArgument,
          wrappedFrontendInvokes,
          dynamicFrontendInvokes,
          callsite,
          staticStrings
        );
        return;
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "listen"
      ) {
        collectLiteralOrDynamic(firstArgument, frontendListens,
          dynamicFrontendListens, callsite, staticStrings);
        return;
      }

      if (!ts.isIdentifier(node.expression)) return;
      const callee = node.expression.text;
      if (tauriBindings.invoke.has(callee)) {
        collectLiteralOrDynamic(
          firstArgument,
          frontendInvokes,
          dynamicFrontendInvokes,
          callsite,
          staticStrings
        );
      }
      if (tauriBindings.listen.has(callee)) {
        collectLiteralOrDynamic(
          firstArgument,
          frontendListens,
          dynamicFrontendListens,
          callsite,
          staticStrings
        );
      }
      if (tauriBindings.emit.has(callee)) {
        collectLiteralOrDynamic(
          firstArgument,
          frontendEmits,
          dynamicFrontendEmits,
          callsite,
          staticStrings
        );
      }
    });
  }

  const importGraph = buildImportGraph(sourceFiles, imports, repositoryRoot);
  const cycles = findStronglyConnectedComponents(importGraph)
    .filter((component) => component.length > 1 || importGraph.get(component[0])?.has(component[0]))
    .map((component) => component.sort())
    .sort(compareStringArrays);
  const importCycleEdges = collectCycleEdges(importGraph, cycles);
  const broadMeetingBarrelConsumers = uniqueSorted(
    imports
      .filter((entry) => entry.resolved === "src/lib/meeting/index.ts")
      .map((entry) => entry.file)
  );
  const rustAnalysis = analyzeRust(repositoryRoot, rustFiles);

  return {
    importDependencies: imports
      .map((entry) => ({ file: entry.file, target: entry.resolved ?? entry.specifier })),
    sourceFileCount: sourceFiles.length,
    rustFileCount: rustFiles.length,
    taskMutationCalls: sortCallsites(taskMutationCalls),
    broadMeetingBarrelConsumers,
    legacyReaderImports: imports
      .filter((entry) => entry.resolved?.startsWith("src/lib/legacy-readers/"))
      .map((entry) => ({
        file: entry.file,
        target: entry.resolved,
      }))
      .sort(compareObjects),
    importCycles: cycles,
    importCycleEdges,
    ipc: {
      registeredCommands: rustAnalysis.registeredCommands,
      staticFrontendInvokes: uniqueSorted(frontendInvokes.map((item) => item.value)),
      wrappedFrontendInvokes: uniqueSorted(
        wrappedFrontendInvokes.map((item) => item.value)
      ),
      dynamicFrontendInvokeCallsites: summarizeDynamicCallsites(
        dynamicFrontendInvokes
      ),
      nativeEmittedEvents: rustAnalysis.emittedEvents,
      nativeListenedEvents: rustAnalysis.listenedEvents,
      staticFrontendEmittedEvents: uniqueSorted(
        frontendEmits.map((item) => item.value)
      ),
      staticFrontendListenedEvents: uniqueSorted(
        frontendListens.map((item) => item.value)
      ),
      dynamicFrontendEmitCallsites: summarizeDynamicCallsites(
        dynamicFrontendEmits
      ),
      dynamicFrontendListenCallsites: summarizeDynamicCallsites(
        dynamicFrontendListens
      ),
    },
  };
}

export function evaluateArchitectureAnalysis({ analysis, contract, ledger }) {
  const errors = [];
  const ledgerValidation = validateDeletionLedger(ledger);
  if (!ledgerValidation.ok) {
    errors.push(
      ...ledgerValidation.errors.map((error) => `deletion-ledger: ${error}`)
    );
  }
  validateContract(contract, errors);
  if (errors.length > 0) return buildEvaluation(analysis, ledgerValidation, errors);

  validateTaskMutation(analysis, contract, errors);
  validateLegacyReaderImports(analysis, contract, errors);
  validateCycles(analysis, contract, errors);
  validateDependencyBoundaries(analysis, contract, errors);
  validateBroadBarrel(analysis, contract, errors);
  validateIpc(analysis, contract, errors);
  validateDeletedPatterns(contract.repositoryRoot, ledger, errors);

  return buildEvaluation(analysis, ledgerValidation, errors);
}

export function loadArchitectureContract(
  repositoryRoot = process.cwd(),
  contractPath = path.join("architecture", "architecture-contract.json")
) {
  const value = JSON.parse(
    fs.readFileSync(path.resolve(repositoryRoot, contractPath), "utf8")
  );
  return { ...value, repositoryRoot };
}

export function createArchitectureContractBaseline(existingContract, sourceCommit) {
  const errors = [];
  validateContract(existingContract, errors);
  if (errors.length > 0) {
    throw new Error(`Invalid architecture contract: ${errors.join("; ")}`);
  }
  const baseline = structuredClone(existingContract);
  delete baseline.repositoryRoot;
  delete baseline.taskMutation.methodNames;
  baseline.sourceCommit = sourceCommit;
  return baseline;
}

const TASK_MUTATION_METHODS = new Set([
  // Current mutation APIs.
  "clearTaskRuntime",
  "commitTaskRuntimeTransition",
  "commitPreparedTaskRuntimeTransition",
  "installPreparedTaskDeadlineUpdate",
  "rollbackPreparedTaskDeadlineUpdate",
  "rollbackPreparedTaskRuntimeTransition",
  // Retired APIs remain discoverable under the same module/callsite policy.
  "clearActiveInterviewTask",
  "clearActiveMeetingTask",
  "clearActiveScreenTask",
  "setActiveInterviewTask",
  "setActiveMeetingTaskState",
  "setActiveScreenTask",
]);

function collectTauriBindings(sourceFile) {
  const bindings = {
    invoke: new Set(),
    listen: new Set(),
    emit: new Set(),
  };
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const local = element.name.text;
      if (specifier === "@tauri-apps/api/core" && imported === "invoke") {
        bindings.invoke.add(local);
      }
      if (specifier === "@tauri-apps/api/event" && imported === "listen") {
        bindings.listen.add(local);
      }
      if (specifier === "@tauri-apps/api/event" && imported === "emit") {
        bindings.emit.add(local);
      }
    }
  }
  return bindings;
}

function collectLiteralOrDynamic(
  argument,
  literals,
  dynamics,
  callsite,
  staticStrings = new Map()
) {
  const value = readStaticString(argument, staticStrings);
  if (value !== undefined) literals.push({ ...callsite, value });
  else dynamics.push(callsite);
}

function readStaticString(node, staticStrings) {
  if (
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  if (node && ts.isIdentifier(node)) return staticStrings.get(node.text);
  return undefined;
}

function collectExportedStringConstants(
  parsedSources,
  repositoryRoot,
  sourceFileSet
) {
  const exportedByFile = new Map();
  for (const [absoluteFile, sourceFile] of parsedSources) {
    const file = relative(repositoryRoot, absoluteFile);
    const exports = new Map();
    exportedByFile.set(file, exports);
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const isExported = statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      );
      if (!isExported) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const value = readStaticString(declaration.initializer, new Map());
        if (value !== undefined) exports.set(declaration.name.text, value);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [absoluteFile, sourceFile] of parsedSources) {
      const file = relative(repositoryRoot, absoluteFile);
      const exports = exportedByFile.get(file);
      for (const statement of sourceFile.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          !statement.moduleSpecifier ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          continue;
        }
        const resolved = resolveSourceImport(
          repositoryRoot,
          absoluteFile,
          statement.moduleSpecifier.text,
          sourceFileSet
        );
        const targetExports = resolved ? exportedByFile.get(resolved) : undefined;
        if (!targetExports) continue;
        if (!statement.exportClause) {
          for (const [name, value] of targetExports) {
            if (!exports.has(name)) {
              exports.set(name, value);
              changed = true;
            }
          }
          continue;
        }
        if (!ts.isNamedExports(statement.exportClause)) continue;
        for (const element of statement.exportClause.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          const value = targetExports.get(imported);
          if (value !== undefined && !exports.has(element.name.text)) {
            exports.set(element.name.text, value);
            changed = true;
          }
        }
      }
    }
  }

  const exported = new Map();
  for (const [file, values] of exportedByFile) {
    for (const [name, value] of values) exported.set(`${file}#${name}`, value);
  }
  return exported;
}

function collectStaticStringBindings(
  sourceFile,
  absoluteFile,
  repositoryRoot,
  sourceFileSet,
  exportedStringConstants
) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const value = readStaticString(declaration.initializer, bindings);
        if (value !== undefined) bindings.set(declaration.name.text, value);
      }
      continue;
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const resolved = resolveSourceImport(
      repositoryRoot,
      absoluteFile,
      statement.moduleSpecifier.text,
      sourceFileSet
    );
    if (!resolved) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const value = exportedStringConstants.get(`${resolved}#${imported}`);
      if (value !== undefined) bindings.set(element.name.text, value);
    }
  }
  return bindings;
}

function analyzeRust(repositoryRoot, rustFiles) {
  const source = rustFiles
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const registrationMatch = source.match(
    /generate_handler!\s*\[([\s\S]*?)\]\s*\)/m
  );
  const registeredCommands = registrationMatch
    ? uniqueSorted(
        registrationMatch[1]
          .replace(/#\[[^\]]+\]/g, "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => entry.split("::").at(-1))
          .filter(Boolean)
      )
    : [];

  const emittedEvents = uniqueSorted(rustFiles.flatMap((file) =>
    collectRustEmittedEvents(fs.readFileSync(file, "utf8"))));
  const listenedEvents = extractRustStringCalls(source, /\.listen(?:_global)?\s*\(\s*"([^"]+)"/g);
  return { registeredCommands, emittedEvents, listenedEvents };
}

export function collectRustEmittedEvents(source) {
  const constants = new Map([...source.matchAll(
    /\bconst\s+(\w+)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]+)"/g
  )].map((match) => [match[1], match[2]]));
  const patterns = [
    /\.emit\s*\(\s*(?:"([^"]+)"|([A-Za-z_]\w*))/g,
    /\.emit_to\s*\(\s*(?:"[^"]*"|[A-Za-z_][\w:]*)\s*,\s*(?:"([^"]+)"|([A-Za-z_]\w*))/g,
  ];
  return uniqueSorted(patterns.flatMap((pattern) => [...source.matchAll(pattern)]
    .map((match) => match[1] ?? constants.get(match[2]))
    .filter((value) => value !== undefined)));
}

function extractRustStringCalls(source, pattern) {
  return uniqueSorted([...source.matchAll(pattern)].map((match) => match[1]));
}

function resolveSourceImport(
  repositoryRoot,
  importingFile,
  specifier,
  sourceFileSet
) {
  let base;
  if (specifier.startsWith("@/")) {
    base = path.join(repositoryRoot, "src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(importingFile), specifier);
  } else {
    return undefined;
  }

  const candidates = [];
  const extension = path.extname(base);
  if (extension === ".js" || extension === ".jsx") {
    candidates.push(base.slice(0, -extension.length) + ".ts");
    candidates.push(base.slice(0, -extension.length) + ".tsx");
  } else if (SOURCE_EXTENSIONS.has(extension)) {
    candidates.push(base);
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`);
    candidates.push(path.join(base, "index.ts"), path.join(base, "index.tsx"));
  }
  const resolved = candidates.find((candidate) => sourceFileSet.has(path.resolve(candidate)));
  return resolved ? relative(repositoryRoot, resolved) : undefined;
}

function buildImportGraph(sourceFiles, imports, repositoryRoot) {
  const graph = new Map(
    sourceFiles.map((file) => [relative(repositoryRoot, file), new Set()])
  );
  for (const entry of imports) {
    if (entry.resolved && graph.has(entry.resolved)) {
      graph.get(entry.file)?.add(entry.resolved);
    }
  }
  return graph;
}

function findStronglyConnectedComponents(graph) {
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let index = 0;

  function connect(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of graph.get(node) ?? []) {
      if (!indices.has(neighbor)) {
        connect(neighbor);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node), lowLinks.get(neighbor))
        );
      } else if (onStack.has(neighbor)) {
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node), indices.get(neighbor))
        );
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const current = stack.pop();
      onStack.delete(current);
      component.push(current);
      if (current === node) break;
    }
    components.push(component);
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) connect(node);
  }
  return components;
}

function collectCycleEdges(graph, cycles) {
  const componentByFile = new Map();
  for (const cycle of cycles) {
    const key = canonicalComponent(cycle);
    for (const file of cycle) componentByFile.set(file, key);
  }
  const edges = [];
  for (const [source, targets] of graph) {
    const component = componentByFile.get(source);
    if (!component) continue;
    for (const target of targets) {
      if (componentByFile.get(target) === component) {
        edges.push(`${source} -> ${target}`);
      }
    }
  }
  return uniqueSorted(edges);
}

function validateContract(contract, errors) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    errors.push("architecture contract must be an object");
    return;
  }
  if (contract.version !== 1) errors.push("architecture contract version must equal 1");
  for (const key of ["taskMutation", "legacyReaders", "imports", "ipc"]) {
    if (!contract[key] || typeof contract[key] !== "object" || Array.isArray(contract[key])) {
      errors.push(`architecture contract is missing ${key}`);
    }
  }
  if (!contract.imports || typeof contract.imports !== "object" || Array.isArray(contract.imports)) return;
  for (const key of ["allowedCycleEdges", "broadMeetingBarrelAllowedConsumers"]) {
    const values = contract.imports[key];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
      errors.push(`architecture contract imports.${key} must be a string array`);
    }
  }
  if (!Array.isArray(contract.imports.allowedCycles) || contract.imports.allowedCycles.some(
    (group) => !Array.isArray(group) || group.length === 0 || group.some((file) => typeof file !== "string" || !file.trim())
  )) {
    errors.push("architecture contract imports.allowedCycles must contain nonempty module arrays");
  }
  if (
    !Array.isArray(contract.imports.acyclicModules) ||
    contract.imports.acyclicModules.some((module) => typeof module !== "string" || !module.trim())
  ) {
    errors.push("architecture contract imports.acyclicModules must be a string array");
  }
  if (
    !contract.imports.contractDependencies ||
    typeof contract.imports.contractDependencies !== "object" ||
    Array.isArray(contract.imports.contractDependencies)
  ) {
    errors.push("architecture contract imports.contractDependencies must be an object");
  } else {
    for (const [file, dependencies] of Object.entries(contract.imports.contractDependencies)) {
      if (
        !Array.isArray(dependencies) ||
        dependencies.some((dependency) => typeof dependency !== "string" || !dependency.trim())
      ) {
        errors.push(`architecture contract imports.contractDependencies.${file} must be a string array`);
      }
    }
  }
}

function validateTaskMutation(analysis, contract, errors) {
  const allowed = new Map(
    (contract.taskMutation.allowedModules ?? []).map((entry) => [
      entry.file,
      entry.maxCallsites,
    ])
  );
  const actual = groupCallsiteCounts(analysis.taskMutationCalls);
  for (const entry of actual) {
    if (!allowed.has(entry.file)) {
      errors.push(`task-writer: unauthorized module ${entry.file}`);
      continue;
    }
    if (entry.maxCallsites > allowed.get(entry.file)) {
      errors.push(
        `task-writer: ${entry.file} has ${entry.maxCallsites} callsites; ` +
          `baseline allows ${allowed.get(entry.file)}`
      );
    }
  }
}

function validateLegacyReaderImports(analysis, contract, errors) {
  const allowedRoots = contract.legacyReaders.allowedImporterRoots ?? [];
  for (const entry of analysis.legacyReaderImports) {
    if (!allowedRoots.some((root) => isWithin(entry.file, root))) {
      errors.push(
        `legacy-reader: live module ${entry.file} imports ${entry.target}`
      );
    }
  }
}

function validateCycles(analysis, contract, errors) {
  const allowed = contract.imports.allowedCycles.map((group) => new Set(group));
  for (const cycle of analysis.importCycles) {
    if (!allowed.some((group) => cycle.every((file) => group.has(file)))) {
      errors.push(`import-cycle: ${cycle.join(" -> ")}`);
    }
  }
  const allowedEdges = new Set(contract.imports.allowedCycleEdges ?? []);
  for (const edge of analysis.importCycleEdges ?? []) {
    if (!allowedEdges.has(edge)) errors.push(`import-cycle-edge: ${edge}`);
  }
}

function validateDependencyBoundaries(analysis, contract, errors) {
  const protectedModules = new Set(contract.imports.acyclicModules ?? []);
  for (const dependency of analysis.importDependencies ?? []) {
    if (protectedModules.has(dependency.file) && dependency.target === "<computed-module>") {
      errors.push(`protected-module-dynamic-import: ${dependency.file}`);
    }
  }
  for (const cycle of analysis.importCycles) {
    if (cycle.some((file) => protectedModules.has(file))) {
      errors.push(`protected-module-cycle: ${cycle.join(" -> ")}`);
    }
  }
  for (const [file, allowed] of Object.entries(contract.imports.contractDependencies ?? {})) {
    const permitted = new Set(allowed);
    for (const dependency of analysis.importDependencies ?? []) {
      if (dependency.file === file && !permitted.has(dependency.target)) {
        errors.push(`contract-dependency: ${file} cannot import ${dependency.target}`);
      }
    }
  }
}

function validateBroadBarrel(analysis, contract, errors) {
  const allowed = new Set(
    contract.imports.broadMeetingBarrelAllowedConsumers ?? []
  );
  for (const consumer of analysis.broadMeetingBarrelConsumers) {
    if (!allowed.has(consumer)) {
      errors.push(`meeting-barrel: new consumer ${consumer}`);
    }
  }
}

function validateIpc(analysis, contract, errors) {
  const fields = [
    "registeredCommands",
    "staticFrontendInvokes",
    "wrappedFrontendInvokes",
    "nativeEmittedEvents",
    "nativeListenedEvents",
    "staticFrontendEmittedEvents",
    "staticFrontendListenedEvents",
  ];
  for (const field of fields) {
    compareExactSets(
      analysis.ipc[field] ?? [],
      contract.ipc[field] ?? [],
      `ipc.${field}`,
      errors
    );
  }
  for (const field of [
    "dynamicFrontendInvokeCallsites",
    "dynamicFrontendEmitCallsites",
    "dynamicFrontendListenCallsites",
  ]) {
    compareBoundedCallsites(
      analysis.ipc[field] ?? [],
      contract.ipc[field] ?? [],
      `ipc.${field}`,
      errors
    );
  }
  validateIpcReconciliation(analysis.ipc, contract.ipc.reconciliation, errors);
}

function validateIpcReconciliation(ipc, reconciliation, errors) {
  if (!reconciliation || typeof reconciliation !== "object") {
    errors.push("ipc.reconciliation: missing explicit mismatch registry");
    return;
  }
  const calledCommands = uniqueSorted([
    ...(ipc.staticFrontendInvokes ?? []),
    ...(ipc.wrappedFrontendInvokes ?? []),
  ]);
  const checks = [
    [
      "allowedFrontendCommandsWithoutNativeRegistration",
      difference(calledCommands, ipc.registeredCommands),
    ],
    [
      "allowedNativeCommandsWithoutFrontendCall",
      difference(ipc.registeredCommands, calledCommands),
    ],
    [
      "allowedNativeEventsWithoutFrontendListener",
      difference(ipc.nativeEmittedEvents, ipc.staticFrontendListenedEvents),
    ],
    [
      "allowedFrontendListenersWithoutNativeEmitter",
      difference(ipc.staticFrontendListenedEvents, ipc.nativeEmittedEvents),
    ],
    [
      "allowedFrontendEventsWithoutNativeListener",
      difference(ipc.staticFrontendEmittedEvents, ipc.nativeListenedEvents),
    ],
    [
      "allowedNativeListenersWithoutFrontendEmitter",
      difference(ipc.nativeListenedEvents, ipc.staticFrontendEmittedEvents),
    ],
  ];
  for (const [field, actual] of checks) {
    const entries = reconciliation[field];
    if (!Array.isArray(entries)) {
      errors.push(`ipc.reconciliation.${field}: must be an array`);
      continue;
    }
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry.name !== "string" ||
        typeof entry.reason !== "string" ||
        entry.reason.trim().length < 8
      ) {
        errors.push(
          `ipc.reconciliation.${field}: each exception needs name and reason`
        );
      }
    }
    compareExactSets(
      actual,
      entries.map((entry) => entry.name),
      `ipc.reconciliation.${field}`,
      errors
    );
  }
}

function validateDeletedPatterns(repositoryRoot, ledger, errors) {
  if (!repositoryRoot) return;
  const searchableFiles = [
    ...walkFiles(path.join(repositoryRoot, "src"), SOURCE_EXTENSIONS),
    ...walkFiles(path.join(repositoryRoot, "src-tauri", "src"), new Set([RUST_EXTENSION])),
  ];
  const sourceTexts = new Map();
  for (const entry of ledger.entries ?? []) {
    if (entry.status !== "deleted") continue;
    for (const pattern of entry.forbiddenPatterns ?? []) {
      for (const file of searchableFiles) {
        if (!sourceTexts.has(file)) sourceTexts.set(file, fs.readFileSync(file, "utf8"));
        if (sourceTexts.get(file).includes(pattern)) {
          errors.push(
            `deleted-surface: ${entry.id} pattern ${JSON.stringify(pattern)} ` +
              `reappeared in ${relative(repositoryRoot, file)}`
          );
        }
      }
    }
  }
}

function compareExactSets(actualValues, expectedValues, label, errors) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  for (const value of actual) {
    if (!expected.has(value)) errors.push(`${label}: unregistered ${value}`);
  }
  for (const value of expected) {
    if (!actual.has(value)) errors.push(`${label}: missing ${value}`);
  }
}

function compareBoundedCallsites(actual, expected, label, errors) {
  const allowed = new Map(expected.map((entry) => [entry.file, entry.maxCallsites]));
  for (const entry of actual) {
    if (!allowed.has(entry.file)) {
      errors.push(`${label}: unregistered dynamic callsite ${entry.file}`);
    } else if (entry.maxCallsites > allowed.get(entry.file)) {
      errors.push(
        `${label}: ${entry.file} has ${entry.maxCallsites}; ` +
          `baseline allows ${allowed.get(entry.file)}`
      );
    }
  }
}

function buildEvaluation(analysis, ledgerValidation, errors) {
  const calledCommands = uniqueSorted([
    ...(analysis.ipc.staticFrontendInvokes ?? []),
    ...(analysis.ipc.wrappedFrontendInvokes ?? []),
  ]);
  return {
    ok: errors.length === 0,
    errors,
    metrics: {
      sourceFiles: analysis.sourceFileCount,
      rustFiles: analysis.rustFileCount,
      taskWriterCallsites: analysis.taskMutationCalls.length,
      taskWriterModules: groupCallsiteCounts(analysis.taskMutationCalls).length,
      liveLegacyImports: analysis.legacyReaderImports.length,
      importCycles: analysis.importCycles.length,
      importCycleEdges: analysis.importCycleEdges.length,
      broadMeetingBarrelConsumers:
        analysis.broadMeetingBarrelConsumers.length,
      registeredCommands: analysis.ipc.registeredCommands.length,
      staticFrontendInvokes: analysis.ipc.staticFrontendInvokes.length,
      wrappedFrontendInvokes: analysis.ipc.wrappedFrontendInvokes.length,
      frontendCommandsWithoutNativeRegistration: difference(
        calledCommands,
        analysis.ipc.registeredCommands
      ).length,
      nativeCommandsWithoutFrontendCall: difference(
        analysis.ipc.registeredCommands,
        calledCommands
      ).length,
      deletionLedgerEntries: ledgerValidation.entryCount,
      deletionLedgerStatuses: ledgerValidation.statusCounts,
    },
  };
}

function summarizeDynamicCallsites(callsites) {
  return groupCallsiteCounts(callsites);
}

function groupCallsiteCounts(callsites) {
  const counts = new Map();
  for (const callsite of callsites) {
    counts.set(callsite.file, (counts.get(callsite.file) ?? 0) + 1);
  }
  return [...counts]
    .map(([file, maxCallsites]) => ({ file, maxCallsites }))
    .sort(compareObjects);
}

function sortCallsites(callsites) {
  return [...callsites].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      String(left.method ?? "").localeCompare(String(right.method ?? ""))
  );
}

function walkFiles(root, extensions) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (extensions.has(path.extname(entry.name))) files.push(absolute);
    }
  }
  return files.sort();
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function difference(left, right) {
  const rightSet = new Set(right ?? []);
  return uniqueSorted((left ?? []).filter((value) => !rightSet.has(value)));
}

function canonicalComponent(component) {
  return [...component].sort().join("|");
}

function compareStringArrays(left, right) {
  return canonicalComponent(left).localeCompare(canonicalComponent(right));
}

function compareObjects(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function isWithin(file, root) {
  return file === root || file.startsWith(`${root}/`);
}

function relative(repositoryRoot, absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}
