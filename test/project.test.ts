import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectProject, MAX_TREE, type Project } from "../src/project.ts";
import { specValidator } from "./helpers/spec.ts";
import { makeTree } from "./helpers/tree.ts";

const SENTINEL = "zq-sentinel-7f3a";

const NODE_FIXTURE = {
  "package.json": JSON.stringify({
    name: "app",
    version: "1.2.3",
    main: "src/index.js",
    type: "module",
    bin: { app: "bin/app.js", bad: 1 },
    files: ["src", "bin"],
    scripts: { build: "node build.js" },
    dependencies: { "pkg-a": "^1.0.0", "@scope/pkg-b": "git+https://example.com/b.git" },
    devDependencies: { "pkg-c": "file:../c" },
  }),
  "packages/lib/package.json": JSON.stringify({ main: 5, type: "other", bin: "cli.js", dependencies: { "pkg-a": "2", "not a name": "1" } }),
  "packages/lib/cli.js": "content",
  "src/index.js": "content",
  "bin/app.js": "content",
  Dockerfile: [
    "# syntax=docker/dockerfile:1",
    "FROM --platform=linux/amd64 node:24 AS build",
    "WORKDIR /app",
    "COPY package.json ./",
    "RUN npm ci",
    "COPY src/ src/",
    "",
    "FROM node:24-slim",
    "WORKDIR /srv",
    "WORKDIR app",
    "COPY --from=build /app/src ./src",
    'COPY ["bin/app.js", "./bin/"]',
    'CMD ["node", "src/index.js"]',
  ].join("\n"),
  ".dockerignore": "# comment\nnode_modules\n\n*.log\n",
  "serverless.yml": [
    "service: app",
    "provider:",
    "  name: aws",
    "  runtime: nodejs22.x",
    "functions:",
    "  one:",
    "    handler: src/index.handler",
    "  two:",
    "    handler: src/two.handler",
    "    runtime: nodejs24.x",
    "    package:",
    "      artifact: dist/two.zip",
    "  three:",
    "    image: example",
  ].join("\n"),
  "node_modules/pkg-a/package.json": JSON.stringify({ dependencies: { hidden: "1" } }),
  ".git/HEAD": "content",
};

const PYTHON_FIXTURE = {
  "requirements.txt": [
    "# comment",
    "pkg-a==1.0",
    "Pkg_B[extra]>=2 ; python_version < '3.12'  # trailing",
    "pkg-c @ https://example.com/c.whl",
    "-r requirements-dev.txt",
    "--index-url https://example.com/simple",
    "-e .",
    "git+https://example.com/d.git#egg=pkg-d",
    "pkg-e \\",
    "    --hash=sha256:abc",
  ].join("\n"),
  "requirements-dev.txt": "pkg-f\n",
  "pyproject.toml": [
    "[project]",
    'name = "app"',
    'dependencies = ["pkg-g~=1.0", "pkg.h"]',
    "[project.optional-dependencies]",
    'extra = ["pkg-i"]',
    "[dependency-groups]",
    'dev = ["pkg-j", { include-group = "extra" }]',
    "[tool.poetry.dependencies]",
    'python = "^3.12"',
    'pkg-k = { version = "1", source = "private" }',
    "[tool.poetry.group.test.dependencies]",
    'pkg-l = "*"',
  ].join("\n"),
  Pipfile: '[packages]\npkg-m = "*"\n[dev-packages]\npkg-n = {git = "https://example.com/n.git"}\n',
  "svc/template.yaml": [
    "AWSTemplateFormatVersion: '2010-09-09'",
    "Transform: AWS::Serverless-2016-10-31",
    "Globals:",
    "  Function:",
    "    Runtime: python3.13",
    "Resources:",
    "  One:",
    "    Type: AWS::Serverless::Function",
    "    Properties:",
    "      CodeUri: src/",
    "      Handler: app.handler",
    "  Two:",
    "    Type: AWS::Serverless::Function",
    "    Properties:",
    "      CodeUri: !Ref Location",
    "      Handler: app.handler",
    "  Three:",
    "    Type: AWS::Serverless::Function",
    "    Properties:",
    "      PackageType: Image",
    "  Other:",
    "    Type: AWS::S3::Bucket",
  ].join("\n"),
  "svc/src/app.py": "content",
  "other/template.yaml": "Resources:\n  One:\n    Type: AWS::Serverless::Function\n",
  "app.Dockerfile": [
    "FROM python:3.13",
    "COPY requirements.txt \\",
    "     pyproject.toml /app/",
    "RUN <<EOF",
    "COPY ignored /nowhere",
    "EOF",
    "ADD https://example.com/a.tgz /tmp/",
    "ADD svc/src /app/src",
  ].join("\n"),
  "app.Dockerfile.dockerignore": "*.pyc\n",
  ".venv/lib/x.py": "content",
  "env1/pyvenv.cfg": "content",
  "env1/lib/y.py": "content",
  "svc/__pycache__/app.cpython-313.pyc": "content",
};

describe("collectProject", () => {
  it("collects a Node project", async () => {
    expect(await collectProject(makeTree(NODE_FIXTURE))).toEqual({
      tree: [
        ".dockerignore",
        "Dockerfile",
        "package.json",
        "serverless.yml",
        "bin/app.js",
        "src/index.js",
        "packages/lib/cli.js",
        "packages/lib/package.json",
      ],
      dependencies: { node: ["@scope/pkg-b", "pkg-a", "pkg-c"], python: [] },
      manifests: {
        "package.json": { main: "src/index.js", type: "module", bin: { app: "bin/app.js" }, files: ["src", "bin"] },
        "packages/lib/package.json": { bin: "cli.js" },
      },
      docker: {
        Dockerfile: {
          stages: [
            { from: "node:24", workdir: "/app", copies: [{ src: ["package.json"], dest: "./" }, { src: ["src/"], dest: "src/" }] },
            { from: "node:24-slim", workdir: "/srv/app", copies: [{ src: ["bin/app.js"], dest: "./bin/" }] },
          ],
          ignore: ["node_modules", "*.log"],
        },
      },
      lambda: {
        "serverless.yml": [
          { code_uri: ".", handler: "src/index.handler", runtime: "nodejs22.x" },
          { code_uri: "dist/two.zip", handler: "src/two.handler", runtime: "nodejs24.x" },
        ],
      },
      build_targets: [
        { kind: "docker", path: "Dockerfile", context: "." },
        { kind: "lambda_zip", path: "serverless.yml", context: "." },
        { kind: "lambda_zip", path: "serverless.yml", context: "dist/two.zip" },
      ],
    } satisfies Project);
  });

  it("collects a Python project", async () => {
    expect(await collectProject(makeTree(PYTHON_FIXTURE))).toEqual({
      tree: [
        "Pipfile",
        "app.Dockerfile",
        "app.Dockerfile.dockerignore",
        "pyproject.toml",
        "requirements-dev.txt",
        "requirements.txt",
        "other/template.yaml",
        "svc/template.yaml",
        "svc/src/app.py",
      ],
      dependencies: {
        node: [],
        python: ["pkg-a", "pkg-b", "pkg-c", "pkg-e", "pkg-f", "pkg-g", "pkg-h", "pkg-i", "pkg-j", "pkg-k", "pkg-l", "pkg-m", "pkg-n"],
      },
      manifests: {},
      docker: {
        "app.Dockerfile": {
          stages: [
            {
              from: "python:3.13",
              copies: [
                { src: ["requirements.txt", "pyproject.toml"], dest: "/app/" },
                { src: ["svc/src"], dest: "/app/src" },
              ],
            },
          ],
          ignore: ["*.pyc"],
        },
      },
      lambda: { "svc/template.yaml": [{ code_uri: "src/", handler: "app.handler", runtime: "python3.13" }] },
      build_targets: [
        { kind: "docker", path: "app.Dockerfile", context: "." },
        { kind: "lambda_zip", path: "svc/template.yaml", context: "svc/src" },
      ],
    } satisfies Project);
  });

  it("caps the tree, shallowest paths first", async () => {
    const files: Record<string, string> = { "top.txt": "content" };
    for (let i = 0; i < MAX_TREE; i++) files[`a/${String(i).padStart(4, "0")}.txt`] = "content";
    const { tree } = await collectProject(makeTree(files));
    expect(tree).toHaveLength(MAX_TREE);
    expect(tree[0]).toBe("top.txt");
  });

  it("returns an empty project for a missing directory", async () => {
    expect(await collectProject(fileURLToPath(new URL("./does-not-exist", import.meta.url)))).toEqual({
      tree: [],
      dependencies: { node: [], python: [] },
      manifests: {},
      docker: {},
      lambda: {},
      build_targets: [],
    });
  });

  it("skips files it cannot parse", async () => {
    const project = await collectProject(makeTree({ "package.json": "{", "pyproject.toml": "[", "template.yaml": "a: [" }));
    expect(project.manifests).toEqual({});
    expect(project.dependencies).toEqual({ node: [], python: [] });
  });
});

describe("the request body", () => {
  const validate = specValidator("CanaryRequest");
  const request = (project: Project) => ({ action_version: "1.0.0", pipeline: { findings: [], incomplete: false }, project });
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));

  it.each([
    ["Node", () => makeTree(NODE_FIXTURE)],
    ["Python", () => makeTree(PYTHON_FIXTURE)],
    ["empty", () => makeTree({})],
    ["this repository", () => repoRoot],
  ])("matches the published schema for the %s fixture", async (_name, root) => {
    const ok = validate(request(await collectProject(root())));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("never carries versions, scripts, URLs or dropped instructions", async () => {
    const s = SENTINEL;
    const root = makeTree({
      "package.json": JSON.stringify({
        name: s,
        version: `1.0.0-${s}`,
        description: s,
        main: "index.js",
        repository: { url: `https://example.com/${s}` },
        scripts: { [s]: s, build: s },
        config: { key: s },
        bin: { app: "app.js", other: { s } },
        dependencies: { "pkg-a": `^${s}`, "pkg-b": `https://example.com/${s}.tgz`, [`https://${s}`]: "1" },
        devDependencies: { "pkg-c": `git+ssh://${s}` },
      }),
      "requirements.txt": [`pkg-a==${s}`, `pkg-b @ https://example.com/${s}`, `--index-url https://${s}`, `-e git+https://${s}`, `pkg-c # ${s}`, `pkg-d ; extra == "${s}"`].join("\n"),
      "pyproject.toml": `[project]\nname = "${s}"\nversion = "${s}"\ndependencies = ["pkg-e>=${s}"]\n[project.scripts]\nrun = "${s}"\n[tool.poetry.dependencies]\npkg-f = { git = "https://${s}" }\n`,
      Dockerfile: [
        `# ${s}`,
        "FROM node:24",
        `ARG A=${s}`,
        `ENV B=${s}`,
        `LABEL c="${s}"`,
        `RUN echo ${s} \\`,
        `    && echo ${s}`,
        `RUN <<EOF\nCOPY ${s} /x\nEOF`,
        `COPY <<EOF /y\n${s}\nEOF`,
        `COPY --from=${s} /a /b`,
        `ADD https://${s}/a.tgz /tmp/`,
        `ADD git@example.com:${s}.git /src`,
        `HEALTHCHECK CMD ${s}`,
        `ONBUILD COPY ${s} /z`,
        `CMD ["${s}"]`,
        "COPY index.js /app/",
      ].join("\n"),
      "template.yaml": [
        "Transform: AWS::Serverless-2016-10-31",
        "Resources:",
        "  Fn:",
        "    Type: AWS::Serverless::Function",
        "    Properties:",
        "      CodeUri: .",
        "      Handler: index.handler",
        "      Runtime: nodejs22.x",
        "      Environment:",
        "        Variables:",
        `          KEY: ${s}`,
        `      Description: ${s}`,
      ].join("\n"),
      ".github/workflows/template.yml": `Transform: AWS::Serverless\nResources:\n  Fn:\n    Type: AWS::Serverless::Function\n    Properties: { CodeUri: ${s}, Handler: ${s}, Runtime: ${s} }\n`,
      ".github/package.json": JSON.stringify({ main: s, dependencies: { [`pkg-${s}`]: "1" } }),
      "index.js": "content",
      "app.js": "content",
    });
    const project = await collectProject(root);
    expect(JSON.stringify(request(project))).not.toContain(s);
    expect(project.dependencies.node).toEqual(["pkg-a", "pkg-b", "pkg-c"]);
    expect(project.dependencies.python).toEqual(["pkg-a", "pkg-b", "pkg-c", "pkg-d", "pkg-e", "pkg-f"]);
    expect(project.docker.Dockerfile.stages).toEqual([{ from: "node:24", copies: [{ src: ["index.js"], dest: "/app/" }] }]);
    expect(project.lambda["template.yaml"]).toEqual([{ code_uri: ".", handler: "index.handler", runtime: "nodejs22.x" }]);
  });
});
