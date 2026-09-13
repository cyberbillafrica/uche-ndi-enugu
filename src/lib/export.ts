/**
 * Exports data array to downloadable CSV format.
 */
export function exportToCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const headerLine = headers.join(",") + "\n";
  const rowLines = rows
    .map((row) =>
      row
        .map((val) => {
          const str = String(val ?? "").replace(/"/g, '""');
          return `"${str}"`;
        })
        .join(",")
    )
    .join("\n");

  const csvContent = "data:text/csv;charset=utf-8,\uFEFF" + encodeURIComponent(headerLine + rowLines);
  const link = document.createElement("a");
  link.setAttribute("href", csvContent);
  link.setAttribute("download", filename.endsWith(".csv") ? filename : `${filename}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Exports data array to downloadable Excel XML format (.xls / .xlsx compatible).
 */
export function exportToExcel(filename: string, sheetName: string, headers: string[], rows: (string | number)[][]) {
  let xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="${sheetName}">
<Table>
<Row>`;

  headers.forEach((h) => {
    xml += `<Cell><Data ss:Type="String">${h}</Data></Cell>`;
  });
  xml += `</Row>`;

  rows.forEach((r) => {
    xml += `<Row>`;
    r.forEach((val) => {
      const type = typeof val === "number" ? "Number" : "String";
      xml += `<Cell><Data ss:Type="${type}">${val ?? ""}</Data></Cell>`;
    });
    xml += `</Row>`;
  });

  xml += `</Table></Worksheet></Workbook>`;

  const blob = new Blob([xml], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".xls") ? filename : `${filename}.xls`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Triggers standard browser print dialog tailored for formatted PDF export.
 */
export function exportToPDFPrint() {
  window.print();
}
