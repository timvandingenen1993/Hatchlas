/**
 * Town icon library. Settlements are generated (see townSprite.ts); uploaded
 * PNGs are downscaled and kept in IndexedDB: localStorage is limited to a few MB and
 * already holds the studio settings, so image data does not belong there.
 */
import {
  createStructureId,
  DEFAULT_TOWN_ICON_ID,
  settlementOfIcon,
  type IconAsset,
  type SettlementKind,
  type Town,
} from "./types";
import { composeSettlement, svgDataUrl } from "./townSprite";

/**
 * No bundled symbols: every settlement is drawn per town from its seed. The
 * editor's icon list is still this plus the uploads, so it stays an array.
 */
export const BUILTIN_ICONS: readonly IconAsset[] = [];

export { DEFAULT_TOWN_ICON_ID };

const SETTLEMENT_CACHE_LIMIT = 256;
const settlementUrls = new Map<string, string>();

/** Data URL of a settlement sprite; the latest few hundred are kept. */
export function settlementIconUrl(kind: SettlementKind, seed: number): string {
  const cacheKey = `${kind}:${seed}`;
  let url = settlementUrls.get(cacheKey);
  if (url) {
    settlementUrls.delete(cacheKey);
  } else {
    url = svgDataUrl(composeSettlement(kind, seed));
    if (settlementUrls.size >= SETTLEMENT_CACHE_LIMIT) settlementUrls.delete(settlementUrls.keys().next().value!);
  }
  settlementUrls.set(cacheKey, url);
  return url;
}

/** Image URL for a town's icon: its own settlement sprite, a symbol or an upload. */
export function townIconUrl(town: Pick<Town, "iconId" | "seed">, icons: readonly IconAsset[]): string {
  const settlement = settlementOfIcon(town.iconId);
  if (settlement) return settlementIconUrl(settlement.kind, town.seed);
  const icon = icons.find((candidate) => candidate.id === town.iconId);
  return icon ? icon.url : townIconUrl({ iconId: DEFAULT_TOWN_ICON_ID, seed: town.seed }, icons);
}

const DB_NAME = "hatchlas-structures";
const STORE_NAME = "icons";
const MAX_ICON_EDGE = 256;

interface StoredIcon {
  id: string;
  name: string;
  blob: Blob;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open icon storage"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Icon storage failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Icon storage aborted"));
    });
  } finally {
    database.close();
  }
}

export async function loadUploadedIcons(): Promise<IconAsset[]> {
  if (typeof indexedDB === "undefined") return [];
  const stored = await withStore<StoredIcon[]>("readonly", (store) => store.getAll() as IDBRequest<StoredIcon[]>);
  return stored.map((icon) => ({
    id: icon.id,
    name: icon.name,
    builtin: false,
    url: URL.createObjectURL(icon.blob),
  }));
}

async function downscaleImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_ICON_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode icon"))), "image/png");
    });
  } finally {
    bitmap.close();
  }
}

export async function saveUploadedIcon(file: File): Promise<IconAsset> {
  const blob = await downscaleImage(file);
  const icon: StoredIcon = {
    id: createStructureId("icon"),
    name: file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "Icon",
    blob,
  };
  await withStore("readwrite", (store) => store.put(icon));
  return { id: icon.id, name: icon.name, builtin: false, url: URL.createObjectURL(blob) };
}

export async function deleteUploadedIcon(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();

/** Decoded icon image, shared by the overlay and the export stamp builder. */
export function loadIconImage(url: string): Promise<HTMLImageElement> {
  let pending = imageCache.get(url);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not load icon"));
      image.src = url;
    });
    imageCache.set(url, pending);
    pending.catch(() => imageCache.delete(url));
  }
  return pending;
}
