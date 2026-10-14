// Parses filter lists into a serialized blocking engine (runs in a worker thread).
import { parentPort, workerData } from 'worker_threads';
import { FiltersEngine } from '@ghostery/adblocker';

const { lists, resources } = workerData as { lists: string[]; resources: string };
const engine = FiltersEngine.parse(lists.join('\n'), { loadCosmeticFilters: true, loadNetworkFilters: true, enableMutationObserver: true });
if (resources) engine.updateResources(resources, String(resources.length));
const bin = engine.serialize();
parentPort!.postMessage(bin, [bin.buffer as ArrayBuffer]);
