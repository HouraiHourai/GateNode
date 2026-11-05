export interface Item {
  id: number;
  name: string;
}

// Existing API: the exercise is to add optional pagination without breaking this call.
export function listItems(items: readonly Item[]): Item[] {
  return [...items];
}
