/** Display exact arguments without letting invisible directional controls alter the dialog. */
export function confirmationValue(value: string | string[]): string {
  return JSON.stringify(value).replace(
    /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
