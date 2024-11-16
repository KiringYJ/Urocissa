import { usePrefetchStore } from '@/store/prefetchStore'
import { useWorkerStore } from '@/store/workerStore'
import { toDataWorker } from '@/worker/workerApi'
import { bindActionDispatch } from 'typesafe-agent-events'

export function deleteDataInWorker(indexArray: number[]) {
  const workerStore = useWorkerStore('mainId')
  const prefetchStore = usePrefetchStore('mainId')

  if (workerStore.worker === null) {
    workerStore.initializeWorker('mainId')
  }

  const dataWorker = workerStore.worker

  const postToWorker = bindActionDispatch(toDataWorker, (action) => {
    if (dataWorker) {
      dataWorker.postMessage(action)
    }
  })

  const timestamp = prefetchStore.timestamp
  if (timestamp !== null) {
    postToWorker.deleteData({
      indexArray: indexArray,
      timestamp: timestamp
    })
  }
}
