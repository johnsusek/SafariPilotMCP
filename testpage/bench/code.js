// FNV-1a of text in base 36: the code a benchmark page shows once a task is done, which the checker recomputes from the expected input.
export let code = (text) => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }

  return (hash >>> 0).toString(36).toUpperCase();
};
