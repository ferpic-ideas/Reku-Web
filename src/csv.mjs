const splitCsvLine = (line, delimiter) => {
  const values = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === delimiter && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
};

export const parseNominaCsv = (csvText) => {
  const lines = String(csvText || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("El CSV debe tener encabezado y al menos una fila.");
  }

  const delimiter = (lines[0].match(/;/g) || []).length >
    (lines[0].match(/,/g) || []).length
    ? ";"
    : ",";
  const headers = splitCsvLine(lines[0], delimiter).map((header) =>
    header.toLowerCase().trim(),
  );
  const required = ["identificador"];

  for (const header of required) {
    if (!headers.includes(header)) {
      throw new Error("El CSV debe incluir la columna identificador.");
    }
  }

  const indexOf = (name) => headers.indexOf(name);
  const rows = [];

  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line, delimiter);
    const identificador = values[indexOf("identificador")]?.trim() || "";
    if (!identificador) continue;
    rows.push({
      identificador,
      nombre: values[indexOf("nombre")]?.trim() || "",
      apellido: values[indexOf("apellido")]?.trim() || "",
    });
  }

  return rows;
};
