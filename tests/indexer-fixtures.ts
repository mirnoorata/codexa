import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/indexer.js";

export async function createFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-fixture-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "fixture-pkg", exports: { "./feature": "./src/package-entry.ts" }, scripts: { test: "vitest run" }, dependencies: {} }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, "pyproject.toml"), `[project]\ndependencies = ["pytest>=8"]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`, "utf8");
  await mkdirp(path.join(repo, "src"));
  await mkdirp(path.join(repo, "src/a"));
  await mkdirp(path.join(repo, "src/b"));
  await mkdirp(path.join(repo, "src/barrel"));
  await mkdirp(path.join(repo, "src/generated"));
  await mkdirp(path.join(repo, "apps/a/src"));
  await mkdirp(path.join(repo, "apps/b/src"));
  await mkdirp(path.join(repo, "web"));
  await mkdirp(path.join(repo, "web/src/lib"));
  await mkdirp(path.join(repo, "sample_api/packages"));
  await mkdirp(path.join(repo, "sample_api/adapters"));
  await mkdirp(path.join(repo, ".codex/static-analysis"));
  await mkdirp(path.join(repo, "reports"));
  await mkdirp(path.join(repo, "service"));
  await mkdirp(path.join(repo, "service/adapters"));
  await mkdirp(path.join(repo, "service/deep"));
  await mkdirp(path.join(repo, "service/models"));
  await mkdirp(path.join(repo, "src/acme"));
  await mkdirp(path.join(repo, "plugins"));
  await mkdirp(path.join(repo, "scripts"));
  await mkdirp(path.join(repo, "tests"));
  await mkdirp(path.join(repo, "tests/api"));
  await mkdirp(path.join(repo, "tests/unit"));
  await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 1 }\n", "utf8");
  await writeFile(
    path.join(repo, "src/contracts.ts"),
    "export interface BaseContract { id: string }\nexport interface ThingContract extends BaseContract { mode?: ThingMode }\nexport type ThingMode = 'a' | 'b'\nexport enum ThingState { Ready = 'ready' }\nexport class ThingWidget implements ThingContract { id = 'thing' }\nexport default function DefaultThing() { return new ThingWidget() }\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/api.ts"),
    "import { helper } from './util'\nexport function handleThing() { return helper() }\n",
    "utf8"
  );
  await writeFile(path.join(repo, "src/unused-external.ts"), "import { helper } from 'external-pkg'\nexport const untouched = 1\n", "utf8");
  await writeFile(path.join(repo, "src/import-only.ts"), "import { helper } from './util'\nexport const importerReady = true\n", "utf8");
  await writeFile(path.join(repo, "src/default-consumer.ts"), "import DefaultThing from './contracts'\nexport function makeDefault() { return DefaultThing() }\n", "utf8");
  await writeFile(path.join(repo, "src/named-default-missing.ts"), "export function MissingDefault() { return 1 }\n", "utf8");
  await writeFile(path.join(repo, "src/named-default-consumer.ts"), "import MissingDefault from './named-default-missing'\nexport function callMissingDefault() { return MissingDefault() }\n", "utf8");
  await writeFile(path.join(repo, "src/types-only.ts"), "export interface FooTypeOnly { id: string }\n", "utf8");
  await writeFile(path.join(repo, "src/uses-type-only.ts"), "import type { FooTypeOnly } from './types-only'\nexport type WrappedFoo = FooTypeOnly & { ready: boolean }\nexport function invalidRuntimeReference() { return FooTypeOnly }\n", "utf8");
  await writeFile(path.join(repo, "src/symbol-drift.ts"), "export function plannedFoo() {\n  return 1\n}\n\nexport function unplannedBar() {\n  return 2\n}\n", "utf8");
  await writeFile(path.join(repo, "src/barrel.ts"), "export { helper } from './util'\n", "utf8");
  await writeFile(path.join(repo, "src/barrel/helper.ts"), "export function nestedHelper() { return 99 }\n", "utf8");
  await writeFile(path.join(repo, "src/barrel-consumer.ts"), "import { helper } from './barrel'\nexport function useBarrelHelper() { return helper() }\n", "utf8");
  await writeFile(path.join(repo, "src/local-default.ts"), "const localDefault = () => 7\nexport { localDefault as default }\n", "utf8");
  await writeFile(path.join(repo, "src/local-default-consumer.ts"), "import LocalDefault from './local-default'\nexport function useLocalDefault() { return LocalDefault() }\n", "utf8");
  await writeFile(path.join(repo, "src/default-barrel.ts"), "export { default as ContractDefault } from './contracts'\nexport type { ThingContract as PublicThingContract } from './contracts'\n", "utf8");
  await writeFile(path.join(repo, "src/default-barrel-consumer.ts"), "import { ContractDefault } from './default-barrel'\nexport function useDefaultAlias() { return ContractDefault() }\n", "utf8");
  await writeFile(path.join(repo, "src/chained-a.ts"), "export { helper } from './util'\n", "utf8");
  await writeFile(path.join(repo, "src/chained-b.ts"), "export { helper } from './chained-a'\n", "utf8");
  await writeFile(path.join(repo, "src/chained-consumer.ts"), "import { helper as chainedHelper } from './chained-b'\nexport function useChained() { return chainedHelper() }\n", "utf8");
  await writeFile(path.join(repo, "src/ambiguous-a.ts"), "export function sharedHelper() { return 'a' }\n", "utf8");
  await writeFile(path.join(repo, "src/ambiguous-b.ts"), "export function sharedHelper() { return 'b' }\n", "utf8");
  await writeFile(path.join(repo, "src/ambiguous-barrel.ts"), "export * from './ambiguous-a'\nexport * from './ambiguous-b'\n", "utf8");
  await writeFile(path.join(repo, "src/ambiguous-consumer.ts"), "import { sharedHelper } from './ambiguous-barrel'\nexport function useShared() { return sharedHelper() }\n", "utf8");
  await writeFile(
    path.join(repo, "src/aliased.ts"),
    "import { helper as renamedHelper } from './util'\nexport function handleAliasThing() { return renamedHelper() }\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/ns.ts"),
    "import * as util from './util'\nexport function handleNamespaceThing() { return util.helper() }\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/js-ext-import.ts"),
    "import { helper as jsHelper } from './util.js'\nexport function handleJsExtThing() { return jsHelper() }\n",
    "utf8"
  );
  await writeFile(path.join(repo, "src/constants.ts"), "export const VALUE = 1\n", "utf8");
  await writeFile(
    path.join(repo, "src/uses-constant.ts"),
    "import { VALUE as LOCAL_VALUE } from './constants.js'\nexport const ANSWER = LOCAL_VALUE\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/ops.ts"),
    "import { execFileSync } from 'node:child_process'\nimport { writeFile } from 'node:fs/promises'\nexport async function rewriteFile(path: string) { execFileSync('echo', ['ok']); await writeFile(path, 'ok') }\n",
    "utf8"
  );
  await writeFile(path.join(repo, "src/a/config.ts"), "export function config() { return 'a' }\n", "utf8");
  await writeFile(path.join(repo, "src/b/config.ts"), "export function config() { return 'b' }\n", "utf8");
  await writeFile(path.join(repo, "src/generated/client.ts"), "export function generatedClient() { return 'generated' }\n", "utf8");
  await writeFile(path.join(repo, "src/lazy.ts"), "export function lazyValue() { return 'lazy' }\n", "utf8");
  await writeFile(path.join(repo, "src/dynamic-import.ts"), "export async function loadLazy() { return import('./lazy') }\n", "utf8");
  await writeFile(path.join(repo, "src/service-class.ts"), "export class Service { start() { return 1 } }\nexport class Other { start() { return 2 } }\n", "utf8");
  await writeFile(path.join(repo, "src/service-class-consumer.ts"), "import * as mod from './service-class'\nexport function runService() { return mod.Service.start() }\n", "utf8");
  await writeFile(path.join(repo, "src/instance-service-consumer.ts"), "import { Service } from './service-class'\nexport function runInstance(service: Service) { return service.start() }\n", "utf8");
  await writeFile(path.join(repo, "src/object-client.ts"), "export const client = { get() { return 1 } }\nexport function get() { return 2 }\n", "utf8");
  await writeFile(path.join(repo, "src/object-client-consumer.ts"), "import { client } from './object-client'\nexport function runClient() { return client.get() }\n", "utf8");
  await writeFile(path.join(repo, "src/package-entry.ts"), "export function packageFeature() { return 'package' }\n", "utf8");
  await writeFile(path.join(repo, "src/package-consumer.ts"), "import { packageFeature } from 'fixture-pkg/feature'\nexport function runPackageFeature() { return packageFeature() }\n", "utf8");
  await writeFile(path.join(repo, "apps/a/tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }, null, 2), "utf8");
  await writeFile(path.join(repo, "apps/a/src/lib.ts"), "export function aValue() { return 'a' }\n", "utf8");
  await writeFile(path.join(repo, "apps/a/src/use.ts"), "import { aValue } from '@/lib'\nexport function useA() { return aValue() }\n", "utf8");
  await writeFile(path.join(repo, "apps/b/tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }, null, 2), "utf8");
  await writeFile(path.join(repo, "apps/b/src/lib.ts"), "export function bValue() { return 'b' }\n", "utf8");
  await writeFile(path.join(repo, "apps/b/src/use.ts"), "import { bValue } from '@/lib'\nexport function useB() { return bValue() }\n", "utf8");
  await writeFile(
    path.join(repo, "web/tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } }, references: [{ path: "../src" }] }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, "web/src/lib/thing.ts"), "export function thing() { return 'thing' }\n", "utf8");
  await writeFile(path.join(repo, "web/src/Danger.tsx"), "export function Danger({ html }: { html: string }) { return <div dangerouslySetInnerHTML={{ __html: html }} /> }\n", "utf8");
  await writeFile(path.join(repo, "web/src/uses-danger.tsx"), "import { Danger } from './Danger'\nexport function UsesDanger() { return <Danger html=\"ok\" /> }\n", "utf8");
  await writeFile(path.join(repo, "web/src/create-element.tsx"), "import React from 'react'\nimport { Danger } from './Danger'\nexport function MakeDanger() { return React.createElement(Danger, { html: 'ok' }) }\n", "utf8");
  await writeFile(path.join(repo, "web/src/DefaultDanger.tsx"), "export { Danger as default } from './Danger'\n", "utf8");
  await writeFile(path.join(repo, "web/src/uses-default-danger.tsx"), "import DangerDefault from './DefaultDanger'\nexport function UsesDefaultDanger() { return <DangerDefault html=\"ok\" /> }\n", "utf8");
  await writeFile(path.join(repo, "web/src/Wrapped.tsx"), "import { memo } from 'react'\nfunction Inner() { return <span /> }\nexport default memo(function WrappedWidget() { return <Inner /> })\n", "utf8");
  await writeFile(
    path.join(repo, "web/src/feature.ts"),
    "import { thing } from '@/lib/thing'\nexport const nodeType = 'media.audio.transform'\nexport function useFeatureThing() { return thing() }\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "web/src/api-client.ts"),
    "export async function loadThing() {\n  return fetch('/api/thing', { method: 'GET' })\n}\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "web/src/dynamic-api-client.ts"),
    "export async function loadDynamicThing(thingId: string) {\n  return fetch(`/api/things/${thingId}`, { method: 'GET' })\n}\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "web/src/bad-api-client.ts"),
    "export async function loadStaticThing() {\n  return fetch('/api/things/static', { method: 'GET' })\n}\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "web/src/concat-api-client.ts"),
    "export async function loadConcatThing() {\n  return fetch('/api/concat', { method: 'GET' })\n}\n",
    "utf8"
  );
  await writeFile(path.join(repo, "web/src/items-get-client.ts"), "export function getItems() { return fetch('/api/items', { method: 'GET' }) }\n", "utf8");
  await writeFile(path.join(repo, "web/src/items-post-client.ts"), "export function postItems() { return fetch('/api/items', { method: 'POST' }) }\n", "utf8");
  await writeFile(path.join(repo, "web/src/items-put-client.ts"), "export function putItems() { return fetch('/api/items', { method: 'PUT' }) }\n", "utf8");
  await writeFile(path.join(repo, "web/src/default-fetch-client.ts"), "export function defaultFetch() { return fetch('/api/default-fetch') }\n", "utf8");
  await writeFile(path.join(repo, "web/src/default-fetch-post-client.ts"), "function makeHeaders() { return {} }\nexport function defaultFetchPost() {\n  return fetch(\n    '/api/default-fetch',\n    {\n      headers: makeHeaders(),\n      method: 'POST'\n    }\n  )\n}\n", "utf8");
  await writeFile(path.join(repo, "web/src/query-client.ts"), "export function loadQuery() { return fetch('/api/query?limit=25') }\n", "utf8");
  await writeFile(path.join(repo, "web/src/api-constant.ts"), "export const sampleEndpoint = '/api/not-a-route'\n", "utf8");
  await writeFile(
    path.join(repo, "sample_api/packages/project.media.json"),
    JSON.stringify({ nodes: [{ type_id: "media.audio.transform", title: "Speech to Speech", adapter_key: "media.audio.transform" }] }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(repo, "sample_api/packages/project.image.json"),
    JSON.stringify({ nodes: [{ type_id: "image.generate", title: "Image Generate", adapter_key: "image.generate" }] }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, "sample_api/adapters/media.py"), "class MediaAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "sample_api/adapters/image_generate.py"), "class ImageGenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "sample_api/adapters/image.py"), "class ImageAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "sample_api/adapters/generate.py"), "class GenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip()\n", "utf8");
  await writeFile(path.join(repo, "src/acme/__init__.py"), "__all__ = []\n", "utf8");
  await writeFile(path.join(repo, "src/acme/service.py"), "def src_thing(value):\n    return value\n", "utf8");
  await writeFile(path.join(repo, "plugins/tasks.py"), "def run_plugin():\n    return 'plugin'\n", "utf8");
  await writeFile(path.join(repo, "service/adapters/media.py"), "def dispatch(value):\n    return value\n", "utf8");
  await writeFile(path.join(repo, "service/store.py"), "from .adapters.media import dispatch\n\nclass ProjectStore:\n    def normalize_value(self, value):\n        return dispatch(value)\n", "utf8");
  await writeFile(path.join(repo, "service/__init__.py"), "from .helpers import normalize\n", "utf8");
  await writeFile(path.join(repo, "service/deep/utils.py"), "def clean(value):\n    return value.strip()\n", "utf8");
  await writeFile(path.join(repo, "service/deep/internal.py"), "class Real:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "service/deep/__init__.py"), "from .utils import clean as clean_value\nfrom . import internal\nPublic = internal.Real\n__all__ = ['clean_value', 'Public']\n", "utf8");
  await writeFile(
    path.join(repo, "service/app.py"),
    "from .helpers import normalize\nfrom .store import ProjectStore\n\nstore = ProjectStore()\n\n@router.get('/api/thing')\ndef route_thing(value):\n    store = ProjectStore()\n    return store.normalize_value(normalize(value))\n\n@router.get('/api/global-store')\ndef route_global_store(value):\n    return store.normalize_value(normalize(value))\n\n@router.get('/api' + '/concat')\ndef route_concat(value):\n    return normalize(value)\n\n@router.api_route('/api/items', methods=['GET', 'POST'])\ndef route_items(value):\n    return normalize(value)\n\n@router.get(\n    '/api/multiline'\n)\ndef route_multiline_endpoint(value):\n    return normalize(value)\n\n@router.get('/api/default-fetch')\ndef route_default_get(value):\n    return normalize(value)\n\n@router.post('/api/default-fetch')\ndef route_default_post(value):\n    return normalize(value)\n\n@router.get('/api/query')\ndef route_query(value):\n    return normalize(value)\n\n@app.on_event('startup')\ndef on_startup():\n    return None\n\n@router.post('/async')\nasync def route_async(value):\n    return normalize(value)\n\nclass ThingService:\n    def compute(self, value):\n        return normalize(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/models/app.py"),
    "from service.adapters.media import dispatch\n\n@router.get('/api/model-route')\ndef route_model(value):\n    return dispatch(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/collision.py"),
    "@router.get('/api/things/{thing_id}')\ndef route_dynamic_thing(thing_id):\n    return thing_id\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/alias_app.py"),
    "from .helpers import normalize as clean\n\ndef route_alias(value):\n    return clean(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/ns_app.py"),
    "import service.helpers as helpers\n\ndef route_ns(value):\n    return helpers.normalize(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/multiline.py"),
    "from .helpers import (\n    normalize as normalize_multiline,\n)\n\ndef route_multiline(value):\n    return normalize_multiline(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/package_user.py"),
    "from service import normalize\n\ndef route_package(value):\n    return normalize(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/submodule_user.py"),
    "from service import helpers\n\ndef route_submodule(value):\n    return helpers.normalize(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/deep_user.py"),
    "from service.deep import clean_value\n\ndef route_deep(value):\n    return clean_value(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/star_user.py"),
    "from service.deep import *\n\ndef route_star(value):\n    return clean_value(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/reexport_user.py"),
    "from service.deep import Public\n\ndef route_public():\n    return Public()\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/src_layout_user.py"),
    "from acme.service import src_thing\n\ndef route_src_layout(value):\n    return src_thing(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/plugin_user.py"),
    "import plugins.tasks as plugin_tasks\n\ndef route_plugin():\n    return plugin_tasks.run_plugin()\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/frameworks.py"),
    "from fastapi import APIRouter, Depends as FastDepends, FastAPI\nfrom pydantic import BaseModel as SchemaBase, Field\nfrom sqlalchemy.orm import DeclarativeBase, mapped_column\nfrom celery import Celery, shared_task\n\napp = FastAPI()\nrouter = APIRouter()\ncelery_app = Celery(__name__)\n\nclass Item(SchemaBase):\n    id: str\n    title: str = Field(default='')\n\nclass Base(DeclarativeBase):\n    pass\n\nclass User(Base):\n    __tablename__ = 'users'\n    id = mapped_column(primary_key=True)\n    email: str = mapped_column()\n\ndef get_db():\n    return None\n\ndef require_user():\n    return True\n\n@shared_task\ndef rebuild_index_job():\n    return 'ok'\n\n@celery_app.task(name='jobs.rebuild')\ndef rebuild_named_job():\n    return 'ok'\n\ndef schedule_job():\n    celery_app.send_task('jobs.rebuild')\n    return rebuild_named_job.delay()\n\n@router.post('/api/frameworks', dependencies=[FastDepends(require_user)])\ndef create_item(item: Item, db=FastDepends(get_db)):\n    return item\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/framework_sender.py"),
    "import fastapi as fa\nfrom celery import Celery\nfrom service.frameworks import get_db, rebuild_named_job as rebuild_alias\n\nrouter = fa.APIRouter()\ncelery_app = Celery(__name__)\n\n@router.get('/api/framework-sender')\ndef send_framework_task(db=fa.Depends(get_db)):\n    celery_app.send_task('jobs.rebuild')\n    return rebuild_alias.delay()\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/not_fastapi.py"),
    "def Depends(value):\n    return value\n\ndef local_dep():\n    return None\n\ndef use_local_dep(value=Depends(local_dep)):\n    return value\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/not_pydantic_model.py"),
    "from pydantic import BaseModel, Field\n\nclass LocalOptions:\n    label: str = Field(default='local')\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/not_sqlalchemy.py"),
    "def mapped_column(*args, **kwargs):\n    return None\n\nclass Base:\n    pass\n\nclass User(Base):\n    __tablename__ = 'users'\n    id = mapped_column(primary_key=True)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/not_sqlalchemy_import.py"),
    "from sqlalchemy import text\n\ndef mapped_column(*args, **kwargs):\n    return None\n\nclass Base:\n    pass\n\nclass User(Base):\n    __tablename__ = 'users'\n    id = mapped_column(primary_key=True)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/conftest.py"),
    "import pytest\n\n@pytest.fixture\ndef client():\n    return 'root-client'\n\n@pytest.fixture(autouse=True)\ndef reset_state():\n    return None\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/api/conftest.py"),
    "import pytest\n\n@pytest.fixture\ndef client():\n    return 'api-client'\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/unit/conftest.py"),
    "import pytest\n\n@pytest.fixture\ndef client():\n    return 'unit-client'\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/test_app.py"),
    "from service.app import route_thing\nimport pytest\n\nclass TestClient:\n    pass\n\n@pytest.fixture\ndef value():\n    return 'A'\n\n@pytest.fixture\ndef derived(value):\n    return value\n\ndef test_route(value):\n    assert route_thing(value) == 'A'\n\ndef test_route_client(client: TestClient):\n    client.get('/api/thing')\n\ndef test_fixture_dependency(derived):\n    assert derived == 'A'\n\nclass TestFixtureScope:\n    @pytest.fixture\n    def scoped_client(self):\n        return 'scoped'\n\n    def test_inside_class_scope(self, scoped_client):\n        assert scoped_client == 'scoped'\n\ndef test_outside_class_scope(scoped_client):\n    assert scoped_client\n",
    "utf8"
  );
  await writeFile(path.join(repo, "tests/api/test_conftest_scope.py"), "def test_api_client(client):\n    assert client == 'api-client'\n", "utf8");
  await writeFile(path.join(repo, "tests/unit/test_conftest_scope.py"), "def test_unit_client(client):\n    assert client == 'unit-client'\n", "utf8");
  await writeFile(
    path.join(repo, "tests/test_alias_app.py"),
    "from service.alias_app import route_alias\n\ndef test_route_alias():\n    assert route_alias(' A ') == 'A'\n",
    "utf8"
  );
  await writeFile(path.join(repo, "scripts/service-control.sh"), "#!/usr/bin/env bash\nexec echo service\n", "utf8");
  await writeFile(
    path.join(repo, ".codex/static-analysis/semgrep.json"),
    JSON.stringify({ results: [{ check_id: "semgrep.fastapi-auth", path: "service/app.py", start: { line: 3 }, extra: { severity: "WARNING", message: "route should verify auth" } }] }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(repo, "reports/semgrep.json"),
    JSON.stringify(
      {
        runs: [
          {
            results: [
              {
                ruleId: "sarif-shell",
                message: { text: "shell execution needs review" },
                locations: [{ physicalLocation: { artifactLocation: { uri: path.join(repo, "src/../src/ops.ts") }, region: { startLine: 3 } } }]
              },
              {
                ruleId: "sarif-outside",
                message: { text: "outside repo should be ignored" },
                locations: [{ physicalLocation: { artifactLocation: { uri: "/tmp/outside-codexa-risk.py" }, region: { startLine: 1 } } }]
              }
            ]
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

export async function createDocFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-doc-fixture-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "src"));
  await mkdirp(path.join(repo, "docs"));
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/runtime.ts"), "export function runRuntime() { return 'ok' }\n", "utf8");
  await writeFile(
    path.join(repo, "README.md"),
    "# Runtime Guide\n\nThe runtime guide links to [runtime](src/runtime.ts) and keeps `npm run test` visible.\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "docs/workflow.md"),
    "# Workflow Notes\n\nUse pre edit accountability before changing [`runtime`](../src/runtime.ts). This paragraph mentions pre edit accountability and dirty tree review.\n",
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "doc fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

export async function createBroadWorkflowFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-broad-workflow-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "service_noiseflow"));
  await mkdirp(path.join(repo, "tests"));
  await mkdirp(path.join(repo, "src"));
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "pyproject.toml"), `[project]\ndependencies = ["pytest>=8"]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`, "utf8");
  await writeFile(path.join(repo, "service_noiseflow/helpers.py"), "def normalize_noiseflow(value):\n    return value.strip().lower()\n", "utf8");
  await writeFile(
    path.join(repo, "service_noiseflow/app.py"),
    "from .helpers import normalize_noiseflow\n\n@router.post('/noiseflow')\ndef route_noiseflow(value):\n    return normalize_noiseflow(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/test_noiseflow.py"),
    "from service_noiseflow.app import route_noiseflow\n\ndef test_noiseflow_route():\n    assert route_noiseflow(' A ') == 'a'\n",
    "utf8"
  );
  await writeFile(path.join(repo, "src/noiseflow_core.test.ts"), "test('normalize_noiseflow unrelated token noise', () => expect(true).toBe(true))\n", "utf8");
  await writeFile(path.join(repo, "src/noiseflow_feature.ts"), "export const normalize_noiseflow_marker = 'not the route workflow'\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "broad workflow fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  await buildIndex({ repoRoot: repo });
  return repo;
}

export async function createVerificationCoverageFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-verification-coverage-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "src"));
  await mkdirp(path.join(repo, "tests"));
  await mkdirp(path.join(repo, "web/src"));
  await mkdirp(path.join(repo, "packages/foo/src"));
  await mkdirp(path.join(repo, "packages/no-scripts/src"));
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        scripts: {
          typecheck: "tsc -p tsconfig.json --noEmit",
          build: "tsc -p tsconfig.json --noEmit",
          lint: "node scripts/lint-placeholder.mjs",
          test: "vitest run",
          check: "npm run typecheck && npm run lint && npm test",
          maskedtypecheck: "tsc -p tsconfig.json --noEmit || true",
          subtypecheck: "echo $(tsc -p tsconfig.json --noEmit)",
          newlinetypecheck: "tsc -p tsconfig.json --noEmit\nexit 0",
          iftypecheck: "if tsc -p tsconfig.json --noEmit; then echo ok; fi",
          aposttypecheck: "echo \"it's $(tsc -p tsconfig.json --noEmit)\"",
          condtypecheck: 'if [ -n "$CI" ]; then tsc -p tsconfig.json --noEmit; fi',
          exporttypecheck: "export TS_OUT=$(tsc -p tsconfig.json --noEmit)",
          casebuild: "case $NODE_ENV in production) vite build;; esac",
          wrappedbuild: "sh -c 'vite build'",
          definebuild: "vite build --define __HASH__=$(git rev-parse HEAD)",
          exportbuild: "export VERSION=$(git rev-parse HEAD) && next build",
          exportechotypecheck: "export TS_OUT=$(tsc -p tsconfig.json --noEmit) && echo passed",
          echodonebuild: "next build && echo done",
          defineechobuild: "vite build --define __HASH__=$(git rev-parse HEAD) && echo ok",
          buildechohash: 'vite build && echo "built $(git rev-parse HEAD)"',
          exportnextecho: "export V=$(git describe) && next build && echo done",
          wrappedexporttypecheck: 'sh -c "export X=$(tsc -p tsconfig.json --noEmit) && echo ok"',
          aliastypecheck: "command echo $(tsc -p tsconfig.json --noEmit)",
          datetypecheck: "node scripts/lint-placeholder.mjs && echo $(date)",
          gluecheck: "vite $(echo extra) build",
          bgnltypecheck: "tsc -p tsconfig.json --noEmit &\n",
          yarnechobuild: "echo $(yarn build)",
          pnpmechotypecheck: "echo $(pnpm run typecheck)",
          exectypecheck: "exec echo $(tsc -p tsconfig.json --noEmit)",
          echonextypecheck: "echo $(tsc -p tsconfig.json --noEmit) && next build",
          helper: "node scripts/run-tsc.mjs",
          helper2: "TSC=1 esbuild app.ts",
          flowtypecheck: "export TSC=$(tsc --version) && flow check",
          bintsctypecheck: "./node_modules/.bin/tsc -p tsconfig.json --noEmit",
          bracetypecheck: "{ echo $(tsc -p tsconfig.json --noEmit); }",
          grouptypecheck: "( if tsc -p tsconfig.json --noEmit; then :; fi )",
          negtypecheck: "! tsc -p tsconfig.json --noEmit",
          npxtypecheck: "npx -y tsc -p tsconfig.json --noEmit",
          parenstypecheck: "(tsc -p tsconfig.json --noEmit)",
          mixedbuild: "vite build && tsc --version",
          npxversiontypecheck: "npx -y tsc --version",
          helpverify: "node scripts/verify-source-hygiene.mjs --help",
          shhelptypecheck: "sh -c 'tsc --help'",
          gitmsgtypecheck: 'git commit -m "$(tsc -p tsconfig.json --noEmit)"'
        },
        devDependencies: { vitest: "*" }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }, null, 2), "utf8");
  await mkdirp(path.join(repo, "scripts"));
  await writeFile(path.join(repo, "scripts/lint-placeholder.mjs"), "process.exit(0)\n", "utf8");
  await writeFile(path.join(repo, "src/shared.ts"), "export function shared(value: string) { return value.trim().toLowerCase() }\n", "utf8");
  await writeFile(path.join(repo, "tests/shared.test.ts"), "import { shared } from '../src/shared'\ntest('shared', () => expect(shared(' A ')).toBe('a'))\n", "utf8");
  await writeFile(path.join(repo, "tests/other.test.ts"), "import { shared } from '../src/shared'\ntest('other', () => expect(shared(' B ')).toBe('b'))\n", "utf8");
  await writeFile(path.join(repo, "web/package.json"), JSON.stringify({ name: "@acme/widget", scripts: { test: "vitest run" }, devDependencies: { vitest: "*" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "web/src/widget.ts"), "export function widget(value: string) { return value.trim().toLowerCase() }\n", "utf8");
  await writeFile(path.join(repo, "web/src/widget.test.ts"), "import { widget } from './widget'\ntest('widget', () => expect(widget(' C ')).toBe('c'))\n", "utf8");
  await writeFile(path.join(repo, "packages/foo/package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "*" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "packages/foo/src/foo.ts"), "export function foo(value: string) { return value.trim().toLowerCase() }\n", "utf8");
  await writeFile(path.join(repo, "packages/foo/src/foo.test.ts"), "import { foo } from './foo'\ntest('foo', () => expect(foo(' D ')).toBe('d'))\n", "utf8");
  await writeFile(path.join(repo, "packages/no-scripts/package.json"), JSON.stringify({ name: "no-scripts" }, null, 2), "utf8");
  await writeFile(path.join(repo, "packages/no-scripts/src/plain.ts"), "export function plain(value: string) { return value.trim().toLowerCase() }\n", "utf8");
  await writeFile(path.join(repo, "packages/no-scripts/src/plain.test.ts"), "import { plain } from './plain'\ntest('plain', () => expect(plain(' E ')).toBe('e'))\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "verification fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

export async function createSemanticDefaultRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-cache-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await mkdirp(path.join(repo, "src"));
  await writeFile(path.join(repo, "src/local-default.ts"), "const localDefault = () => 7\nexport { localDefault as default }\n", "utf8");
  await writeFile(path.join(repo, "src/local-default-consumer.ts"), "import LocalDefault from './local-default'\nexport function useLocalDefault() { return LocalDefault() }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "semantic-cache"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

export async function createManifestGateFixtureRepo(): Promise<string> {
  const repo = await createFixtureRepo();
  await mkdirp(path.join(repo, "docs"));
  await writeFile(
    path.join(repo, "docs/report.json"),
    JSON.stringify(
      {
        nodes: [{ type_id: "fake.node", title: "Fake Node", adapter_key: "fake.adapter" }],
        meta: { note: "nodes and type_id appear here as ordinary content" }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(repo, "docs/broken.json"), "{\"notManifest\": true,\n", "utf8");
  await writeFile(
    path.join(repo, "sample_api/packages/project.invalid.json"),
    JSON.stringify(
      {
        nodes: { type_id: "fake.node", title: "Fake Node", adapter_key: "fake.adapter" },
        meta: { note: "schema mismatch should stop indexing" }
      },
      null,
      2
    ),
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add-manifest-gate-fixtures"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

export async function createDottedReferenceFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-dotted-reference-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "src"));
  await writeFile(path.join(repo, "src/bar.ts"), "export function bar() { return 1 }\n", "utf8");
  await writeFile(path.join(repo, "src/generate.ts"), "export function generate() { return 2 }\n", "utf8");
  await writeFile(
    path.join(repo, "src/reference.ts"),
    "declare const foo: { bar: number }\n// foo.bar should not become a usage site\nexport const reference = foo.bar\nexport const nodeType = 'image.generate'\n",
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add-dotted-reference-fixtures"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

export async function createManifestLocalityFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-manifest-locality-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "packages/foo/adapters"));
  await mkdirp(path.join(repo, "packages/foo/sub/adapters"));
  await mkdirp(path.join(repo, "packages/bar/adapters"));
  await mkdirp(path.join(repo, "packages/foo"));
  await mkdirp(path.join(repo, "packages/foo/sub"));
  await writeFile(
    path.join(repo, "packages/foo/package.json"),
    JSON.stringify(
      {
        name: "foo",
        nodes: [
          null,
          "not-a-node",
          { type_id: "image.generate", title: "Image Generate", adapter_key: "image.generate" }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(repo, "packages/foo/sub/package.json"),
    JSON.stringify(
      {
        name: "foo-sub",
        nodes: [{ type_id: "image.generate", title: "Nested Image Generate", adapter_key: "image.generate" }]
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(repo, "packages/bar/package.json"), JSON.stringify({ name: "bar" }, null, 2), "utf8");
  await writeFile(path.join(repo, "packages/foo/adapters/image_generate.py"), "class FooImageGenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "packages/foo/sub/adapters/image_generate.py"), "class NestedFooImageGenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "packages/bar/adapters/image_generate.py"), "class BarImageGenerateAdapter:\n    pass\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add-manifest-locality-fixtures"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

export async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
