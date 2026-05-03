# API Reference

## Functions

### `processInput(data: string): Result`

Processes the given input string and returns a structured result.

**Parameters:**
- `data` — the raw input string

**Returns:** A `Result` object with `status` and `value` fields.

## Types

### `Result`

```ts
interface Result {
  status: "ok" | "error";
  value: string;
}
```
