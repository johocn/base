// 平台适配层已上提到 @base/core-ts（P2 接口冻结）；此处仅为过渡期 re-export shim，语义逐字不变。
// 新代码请直接 import from '@base/core-ts/platform/adapter'。
export type {
  FsAdapter,
  StorageAdapter,
  HttpResponse,
  HttpAdapter,
  SqliteConnection,
  PackReader,
  LocalDb,
  Adapters,
} from '@base/core-ts/platform/adapter';
