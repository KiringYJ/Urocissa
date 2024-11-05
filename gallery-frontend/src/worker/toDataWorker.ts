import {
  DataBase,
  DataBaseParse,
  DisplayElement,
  Prefetch,
  Row,
  RowWithOffset,
  ScrollbarData,
  SlicedData,
  SubRow,
  TagInfo,
  batchNumber,
  databaseTimestampSchema,
  fixedBigRowHeight,
  prefetchSchema,
  rowSchema,
  rowWithOffsetSchema,
  scrollbarDataSchema,
  tagInfoSchema
} from '@/script/common/commonType'
import axios from 'axios'
import { bindActionDispatch, createHandler } from 'typesafe-agent-events'
import { fromDataWorker, toDataWorker } from './workerApi'
import { z } from 'zod'

const shouldProcessBatch: number[] = []

const fetchedRowData: Map<number, Row> = new Map()

function unauthorized() {
  const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
  postToMain.unauthorized()
}

// Response interceptor to handle 401 Unauthorized
axios.interceptors.response.use(
  (response) => response, // Pass through valid responses
  async (error) => {
    if (error.response && error.response.status === 401) {
      unauthorized()
      const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
      postToMain.notification({ message: 'Unauthorized. Please log in.', messageType: 'warn' })
    } else {
      const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
      postToMain.notification({ message: 'An error occured', messageType: 'warn' })
    }
    return Promise.reject(error) // Always reject the error to maintain default behavior
  }
)

self.addEventListener('message', (e) => {
  const handler = createHandler<typeof toDataWorker>({
    fetchData: async (payload) => {
      const { batch, timestamp } = payload
      // if there are too many batch are processed then try to terminate the oldest request
      if (shouldProcessBatch.length >= 6) {
        shouldProcessBatch.shift()
      }
      shouldProcessBatch.push(batch)

      const result = await fetchData(batch, timestamp)

      if (result.size > 0) {
        const startIndex = batch * batchNumber
        const endIndex = (batch + 1) * batchNumber
        const indices = Array.from({ length: endIndex - startIndex }, (_, i) => startIndex + i)

        //Push the result Map into a SlicedData[]
        const slicedDataArray: SlicedData[] = []
        for (let i = 0; i < indices.length; i++) {
          const index = indices[i]
          const getResult = result.get(index)
          if (getResult !== undefined) {
            slicedDataArray.push({ index, data: getResult })
          }
        }

        const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
        postToMain.returnData({ batch: batch, slicedDataArray: slicedDataArray })
      }
    },
    fetchRow: async (payload) => {
      const { index, timestamp, windowWidth, isLastRow } = payload

      const rowWithOffset = await fetchRow(index, timestamp, windowWidth, isLastRow)
      if (rowWithOffset !== undefined) {
        const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
        postToMain.fetchRowReturn({
          rowWithOffset: rowWithOffset,
          timestamp: timestamp
        })
      }
    },
    prefetch: async (payload) => {
      const { filterJsonString, priorityId, reverse, locate } = payload
      shouldProcessBatch.push(0)
      const result = await prefetch(filterJsonString, priorityId, reverse, locate)
      const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
      if (result !== undefined) {
        postToMain.prefetchReturn({ result: result })
      }
    },
    editTags: async (payload) => {
      const { indexArray, addTagsArray, removeTagsArray, timestamp } = payload
      const { returnedTagsArray } = await editTags(
        indexArray,
        addTagsArray,
        removeTagsArray,
        timestamp
      )
      const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
      postToMain.editTagsReturn({
        returnedTagsArray: returnedTagsArray
      })
    },
    deleteData: async (payload) => {
      const { indexArray, timestamp } = payload
      await deleteData(indexArray, timestamp)
    },
    fetchScrollbar: async (payload) => {
      const { timestamp } = payload
      const { scrollbarDataArray } = await fetchScrollbar(timestamp)
      const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
      postToMain.fetchScrollbarReturn({ scrollbarDataArray: scrollbarDataArray })
    }
  })
  handler(e.data)
})

/**
 * Prefetches data based on the provided filter criteria, priority, order, and location.
 *
 * @param filterJsonString - A JSON string representing filter criteria. Can be null.
 * @param priorityId - An optional string representing the priority. Defaults to 'default'.
 * @param reverse - An optional string indicating if the order should be reversed. Defaults to 'false'.
 * @param locate - An optional string representing the hash of a photo. Can be null.
 * @returns A promise that resolves to a Prefetch object if successful, or undefined if an error occurs.
 */
async function prefetch(
  filterJsonString: string | null,
  priorityId: string | undefined = 'default',
  reverse: string | undefined = 'false',
  locate: null | string = null
) {
  void priorityId
  void reverse
  const fetchUrl = `/get/prefetch?${locate ? `locate=${locate}` : ''}`

  const axiosResponse = await axios.post<Prefetch>(fetchUrl, filterJsonString, {
    headers: {
      'Content-Type': 'application/json'
    }
  })

  const prefetch = prefetchSchema.parse(axiosResponse.data)

  if (prefetch === null) {
    return
  } else {
    return prefetch
  }
}

/**
 * Fetches a batch of data based on the provided batch index and timestamp.
 * Processes the fetched data into DataBase instances and accumulates them into a map.
 *
 * @param batchIndex - The index of the batch to fetch.
 * @param timestamp - The timestamp associated with the data fetch.
 * @returns A promise that resolves to a Map of data entries keyed by their index,
 *          or an object containing an error message and a warning flag if an error occurs.
 */
async function fetchData(batchIndex: number, timestamp: string) {
  const fetchUrl = `/get/get-data?timestamp=${timestamp}&start=${batchIndex * batchNumber}&end=${
    (batchIndex + 1) * batchNumber
  }`

  const response = await axios.get<DataBase[]>(fetchUrl)
  const databaseTimestampArray = z.array(databaseTimestampSchema).parse(response.data)

  const data: Map<number, DataBase> = new Map()

  for (let index = 0; index < databaseTimestampArray.length; index++) {
    if (!shouldProcessBatch.includes(batchIndex)) {
      break // Stop processing further if the batch should no longer be processed
    }
    const item = databaseTimestampArray[index]
    const isDataBase = z.object({ DataBase: DataBaseParse }).safeParse(item.database)
    if (isDataBase.success) {
      const parsedData = isDataBase.data
      const dataBaseInstance = new DataBase(parsedData.DataBase, item.timestamp)
      const key = batchIndex * batchNumber + index
      data.set(key, dataBaseInstance)
    }

    if (index % 100 === 0) {
      // Yield after every 100 items
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return data
}

/**
 * Fetches a specific row of display elements based on the provided index and timestamp,
 * applies layout algorithms to arrange the elements within the specified window width,
 * and returns the row along with its offset.
 *
 * @param index - The index of the row to fetch.
 * @param timestamp - The timestamp associated with the data fetch.
 * @param windowWidth - The width of the window/container.
 * @returns A promise that resolves to a RowWithOffset object containing the row data and its offset,
 *          or undefined if an error occurs during fetching or parsing.
 */
async function fetchRow(
  index: number,
  timestamp: string,
  windowWidth: number,
  isLastRow: boolean
): Promise<RowWithOffset> {
  let row: Row

  // Obtain row
  if (fetchedRowData.has(index)) {
    row = fetchedRowData.get(index)!
  } else {
    const response = await axios.get<Row>(
      `/get/get-rows?index=${index}&timestamp=${timestamp}&window_width=${Math.round(windowWidth)}`
    )
    row = rowSchema.parse(response.data)
    fetchedRowData.set(row.rowIndex, structuredClone(row))
  }

  // Setting row.topPixelAccumulated
  row.topPixelAccumulated = row.rowIndex * fixedBigRowHeight

  // Perform Algorithm to wrap row into subrows
  const subRows = KnuthPlassLayout(row, windowWidth)

  // Normalize subrows by scaling their widths and heights to fit within the window width
  const scaledTotalHeight = normalizeSubrows(subRows, windowWidth, isLastRow)

  // Setting row.rowHeight
  row.rowHeight = scaledTotalHeight

  // Calculate the offset, which represents the difference between the original default height and the actual wrapped height
  const offset = scaledTotalHeight - fixedBigRowHeight

  const rowWithOffset = rowWithOffsetSchema.parse({
    row: row,
    offset: offset,
    windowWidth
  })

  return rowWithOffset
}

/**
 * Wraps elements into lines based on their widths and the window width,
 * minimizing the badness (unused space squared) of each line.
 *
 * @param displayElements - Array of element widths.
 * @param windowWidth - The width of the window/container.
 * @returns An array where each element represents the number of items in a line.
 */
function lineWrap(displayElements: number[], windowWidth: number): number[] {
  const n = displayElements.length
  const minBadness = Array(n + 1).fill(Infinity)
  const breaks = Array(n + 1).fill(0)

  minBadness[0] = 0

  for (let i = 1; i <= n; i++) {
    let currentWidth = 0
    for (let j = i; j > 0; j--) {
      currentWidth += displayElements[j - 1]

      if (currentWidth > windowWidth) break

      const badness = Math.pow(windowWidth - currentWidth, 2)
      if (minBadness[j - 1] + badness < minBadness[i]) {
        minBadness[i] = minBadness[j - 1] + badness
        breaks[i] = j - 1
      }
    }

    // Check if a valid line break was found. If not, start a new line with the current element.
    if (minBadness[i] === Infinity) {
      minBadness[i] = minBadness[i - 1] + Math.pow(windowWidth - currentWidth, 2)
      breaks[i] = i - 1
    }
  }

  const lineCounts: number[] = []
  let end = n
  while (end > 0) {
    const start = breaks[end]
    lineCounts.unshift(end - start) // Calculate the number of elements in each line
    end = start
  }

  return lineCounts
}

/**
 * Arranges display elements into subrows using the Knuth-Plass layout algorithm.
 *
 * @param row - The row containing display elements to layout.
 * @param windowWidth - The width of the window/container.
 * @returns An array of SubRow objects representing the layout.
 */
function KnuthPlassLayout(row: Row, windowWidth: number): SubRow[] {
  const subRowHeight = Math.min(Math.round(windowWidth) / 2, 250)

  // Calculate the list of widths after scaling based on the subrow height
  const shrinkedWidthList = row.displayElements.map((displayElement) => {
    return (displayElement.displayWidth * subRowHeight) / displayElement.displayHeight
  })

  // Use the lineWrap function to determine how many elements fit in each line
  const lineWrapBatchResult = lineWrap(shrinkedWidthList, windowWidth)

  const allDisplayElement: DisplayElement[] = row.displayElements
  const result: SubRow[] = []

  let startIndex = 0

  // Split allDisplayElement into subrows based on lineWrapBatchResult
  for (const count of lineWrapBatchResult) {
    const subArray = allDisplayElement.slice(startIndex, startIndex + count)
    result.push(new SubRow(subArray))
    startIndex += count
  }

  return result
}

/**
 * Normalize subrows by scaling their widths and heights to fit within the window width.
 *
 * @param subRows - Array of subrows to normalize.
 * @param windowWidth - The width of the window/container.
 * @param paddingLastSubrow - Whether to skip scaling logic for the last subrow.
 * @returns The total scaled height of all subrows.
 */
function normalizeSubrows(
  subRows: SubRow[],
  windowWidth: number,
  paddingLastSubrow: boolean
): number {
  let scaledTotalHeight = 0
  let displayTopPixelAccumulated = 0
  const subRowHeight = Math.min(Math.round(windowWidth) / 2, 250)

  subRows.forEach((subRow, rowIndex) => {
    let widthSum = 0

    // Adjust for the last subrow if paddingLastSubrow is true
    const isLastSubrow = paddingLastSubrow && rowIndex === subRows.length - 1
    // Scale elements in the subrow
    subRow.displayElements.forEach((displayElement) => {
      const width = displayElement.displayWidth
      const height = displayElement.displayHeight

      const scaledWidth = (width * subRowHeight) / height
      displayElement.displayWidth = scaledWidth
      displayElement.displayHeight = subRowHeight
    })
    if (!isLastSubrow) {
      // Calculate total width of elements in the subrow
      widthSum = subRow.displayElements.reduce(
        (sum, displayElement) => sum + displayElement.displayWidth,
        0
      )

      const ratio = (windowWidth - subRow.displayElements.length * 8) / widthSum
      const scaledHeight = subRowHeight * ratio

      // Adjust elements' width and height based on the ratio
      widthSum = 4 // Reset width sum with initial padding
      subRow.displayElements.forEach((displayElement, index) => {
        if (index < subRow.displayElements.length - 1) {
          displayElement.displayWidth = Math.round(displayElement.displayWidth * ratio)
          displayElement.displayHeight = Math.round(scaledHeight)
          widthSum += displayElement.displayWidth + 8
        } else {
          displayElement.displayWidth = windowWidth - widthSum - 4
          displayElement.displayHeight = Math.round(scaledHeight)
        }
        displayElement.displayTopPixelAccumulated = displayTopPixelAccumulated
      })

      displayTopPixelAccumulated += Math.round(scaledHeight + 8)
      scaledTotalHeight += Math.round(scaledHeight + 8)
    } else {
      // Skip scaling logic, use fixed subRowHeight for the last subrow
      subRow.displayElements.forEach((displayElement) => {
        displayElement.displayHeight = subRowHeight
        widthSum += displayElement.displayWidth + 8
        displayElement.displayTopPixelAccumulated = displayTopPixelAccumulated
      })

      displayTopPixelAccumulated += subRowHeight + 8
      scaledTotalHeight += subRowHeight + 8
    }
  })

  return scaledTotalHeight
}

/**
 * Edits tags for specified data entries by adding and removing tags.
 *
 * @param indexArray - An array of indices identifying the data entries to edit.
 * @param addTagsArray - An array of tags to add to the specified data entries.
 * @param removeTagsArray - An array of tags to remove from the specified data entries.
 * @param timestamp - The timestamp associated with the data fetch.
 * @returns A promise that resolves to an object containing the result message, a warning flag,
 *          and optionally an array of returned tags if successful.
 */
const editTags = async (
  indexArray: number[],
  addTagsArray: string[],
  removeTagsArray: string[],
  timestamp: string
): Promise<{ returnedTagsArray?: TagInfo[] }> => {
  const axiosResponse = await axios.put<TagInfo[]>('/put/edit_tag', {
    indexArray,
    addTagsArray,
    removeTagsArray,
    timestamp
  })

  const tagsArraySchema = z.array(tagInfoSchema)
  const response = tagsArraySchema.parse(axiosResponse.data)

  console.log('Successfully edited tags.')
  const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
  postToMain.notification({ message: 'Successfully edited tags.', messageType: 'info' })
  return { returnedTagsArray: response }
}

/**
 * Deletes data entries based on the provided indices.
 *
 * @param indexArray - An array of indices identifying the data entries to delete.
 * @param timestamp - The timestamp associated with the data fetch.
 * @returns A promise that resolves to an object containing the result message and a warning flag.
 */
async function deleteData(indexArray: number[], timestamp: string) {
  await axios.delete('/delete/delete-data', {
    data: { deleteList: indexArray, timestamp }
  })
  console.log('Successfully deleted data.')
  const postToMain = bindActionDispatch(fromDataWorker, self.postMessage.bind(self))
  postToMain.notification({ message: 'Successfully deleted data.', messageType: 'info' })
}

/**
 * Fetches scrollbar data based on the provided timestamp.
 *
 * @param timestamp - The timestamp associated with the data fetch.
 * @returns A promise that resolves to an object containing an array of scrollbar data,
 *          or an empty array if an error occurs.
 */
async function fetchScrollbar(timestamp: string) {
  const response = await axios.get<ScrollbarData[]>(`/get/get-scroll-bar?timestamp=${timestamp}`)
  const scrollBarDataArray = z.array(scrollbarDataSchema).parse(response.data)
  return { scrollbarDataArray: scrollBarDataArray }
}
