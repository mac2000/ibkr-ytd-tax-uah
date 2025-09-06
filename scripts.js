const rates = new Map();
let positions = [];
let trades = [];
let transactions = [];

async function process(files) {
  // reset tables
  document.getElementById("trades-tbody").innerHTML = "";
  document.getElementById("trades-thead").innerHTML = "";
  document.getElementById("positions-tbody").innerHTML = "";
  document.getElementById("positions-thead").innerHTML = "";
  document.getElementById("dividends-income").innerText = "0";
  document.getElementById("dividends-tax").innerText = "0";
  document.getElementById("trades-income").innerText = "0";
  document.getElementById("trades-tax").innerText = "0";
  document.getElementById("positions-income").innerText = "0";
  document.getElementById("positions-tax").innerText = "0";
  document.getElementById("total-income").innerText = "0";
  document.getElementById("total-tax").innerText = "0";

  // parse xml files into DOM docs
  const docs = await Promise.all(Array.from(files ?? []).map(parse));

  // extract relevant data from DOM docs
  positions = docs.flatMap((doc) => getQuerySelectorResults(doc, "OpenPositions OpenPosition"));
  trades = docs.flatMap((doc) => getQuerySelectorResults(doc, "Trades Lot"));
  transactions = docs.flatMap((doc) => getQuerySelectorResults(doc, "CashTransactions CashTransaction"));
  // console.table(positions);
  // console.table(trades);
  // console.table(transactions);

  // fetch exchange rates for given operations
  const tasks = [];
  for (const { currency, dateTime, openDateTime } of [...positions, ...trades, ...transactions]) {
    if (!rates.has(currency)) {
      rates.set(currency, new Map());
      const today = new Date().toISOString().slice(0, 10);
      rates.get(currency).set(today, undefined);
      tasks.push(fetchExchangeRate(today, currency).then((rate) => rates.get(currency).set(today, rate)));
    }
    if (dateTime) {
      const date = dateTime.slice(0, 10);
      if (!rates.get(currency).has(date)) {
        rates.get(currency).set(date, undefined);
        tasks.push(fetchExchangeRate(date, currency).then((rate) => rates.get(currency).set(date, rate)));
      }
    }
    if (openDateTime) {
      const date = openDateTime.slice(0, 10);
      if (!rates.get(currency).has(date)) {
        rates.get(currency).set(date, undefined);
        tasks.push(fetchExchangeRate(date, currency).then((rate) => rates.get(currency).set(date, rate)));
      }
    }
  }
  await Promise.all(tasks);

  // dividends
  for (const transaction of transactions) {
    transaction.rate = rates.get(transaction.currency).get(transaction.dateTime.slice(0, 10));
    transaction.out = transaction.amount * transaction.rate;
    transaction.tax = transaction.out * 0.14;
  }

  // trades
  for (const trade of trades) {
    trade.openRate = rates.get(trade.currency).get(trade.openDateTime.slice(0, 10));
    trade.closeRate = rates.get(trade.currency).get(trade.dateTime.slice(0, 10));

    if (trade.assetCategory === "STK") {
      trade.in = (trade.cost - trade.fifoPnlRealized) * trade.openRate;
      trade.out = trade.cost * trade.closeRate;
    } else if (trade.assetCategory === "OPT") {
      if (trade.buySell === "BUY") {
        trade.in = (-1 * trade.cost - trade.fifoPnlRealized) * trade.openRate;
        trade.out = -1 * trade.cost * trade.closeRate;
      } else if (trade.buySell === "SELL") {
        trade.in = trade.cost * trade.openRate;
        trade.out = (trade.cost + trade.fifoPnlRealized) * trade.closeRate;
      }
    } else {
      console.log("unknown assetCategory", trade.assetCategory, trade);
    }

    trade.pl = trade.out - trade.in;
  }
  renderTrades();

  // positions
  for (const position of positions) {
    position.checked = false;
    position.openRate = rates.get(position.currency).get(position.openDateTime.slice(0, 10));
    position.closeRate = rates.get(position.currency).get(new Date().toISOString().slice(0, 10));

    if (position.assetCategory === "STK") {
      position.in = position.position * position.openPrice * position.openRate;
      position.out = position.position * position.markPrice * position.closeRate;
    } else if (position.assetCategory === "OPT") {
      if (position.side === "Long") {
        position.in = position.markPrice * 100 * position.position * position.closeRate;
        position.out = position.openPrice * 100 * position.position * position.openRate;
      } else {
        position.in = -1 * position.markPrice * 100 * position.position * position.closeRate;
        position.out = -1 * position.openPrice * 100 * position.position * position.openRate;
      }
    } else {
      console.log("unknown assetCategory", position.assetCategory, position);
    }

    position.pl = position.out - position.in;
  }

  renderPositions();

  // totals
  calculateTotals();
}

function getQuerySelectorResults(doc, selector) {
  return Array.from(doc.querySelectorAll(selector)).map(buildElementAttributesMap);
}

function buildElementAttributesMap(el) {
  return Array.from(el.attributes).reduce((acc, attr) => {
    acc[attr.name] = isNaN(attr.value) ? attr.value : parseFloat(attr.value);
    return acc;
  }, {});
}

function parse(file) {
  return new Promise((resolve, reject) => {
    if (file.name.endsWith(".xml") && file.type === "text/xml") {
      const reader = new FileReader();
      reader.onload = (event) => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(event.target.result, "text/xml");
        resolve(doc);
      };
      reader.onerror = (error) => reject(error);
      reader.readAsText(file);
    } else {
      reject(new Error("Invalid file type"));
    }
  });
}

async function fetchExchangeRate(date, currency = "USD") {
  if (currency !== "USD" && currency !== "EUR") {
    throw new Error("Unsupported currency");
  }
  currency = currency.toLowerCase();

  let d = "";
  if (date instanceof Date) {
    d = date.toISOString().slice(0, 10);
  } else if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    d = date.slice(0, 10);
  } else {
    throw new Error("Invalid date format");
  }

  const rate = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=${currency}&date=${d.replaceAll("-", "")}&json`)
    .then((r) => r.json())
    .then((d) => d[0].rate);

  return rate;
}

function renderTrades() {
  const tbodyContainer = document.getElementById("trades-tbody");
  let tbody = "";
  for (const trade of trades) {
    tbody += "<tr>";
    for (const key of Object.keys(trade)) {
      if (isNaN(trade[key])) {
        if (trade[key].match(/^\d{4}-\d{2}-\d{2}/)) {
          tbody += `<td>${trade[key].slice(0, 10)}</td>`;
        } else {
          tbody += `<td>${trade[key]}</td>`;
        }
      } else {
        const cls = [key];
        if (!isNaN(trade[key])) cls.push("number");
        if (trade[key] === 0) cls.push("zero");
        if (trade[key] > 0) cls.push("positive");
        if (trade[key] < 0) cls.push("negative");
        if (Math.abs(trade[key]) > 1000) cls.push("k1");
        if (Math.abs(trade[key]) > 10000) cls.push("k10");
        if (Math.abs(trade[key]) > 100000) cls.push("k100");
        tbody += `<td class="${cls.join(" ")}">${round(trade[key], 2)}</td>`;
      }
    }
    tbody += "</tr>";
  }
  tbodyContainer.innerHTML = tbody;

  const theadContainer = document.getElementById("trades-thead");
  let thead = "<tr>";
  for (const key of Object.keys(trades[0] ?? {})) {
    thead += `<th class="${key}">${key}</th>`;
  }
  thead += "</tr>";
  theadContainer.innerHTML = thead;
}

function round(num, dec) {
  return Math.round(num * 10 ** dec) / 10 ** dec;
}

function renderPositions() {
  const tbodyContainer = document.getElementById("positions-tbody");
  let tbody = "";
  for (const position of positions) {
    const idx = positions.indexOf(position);
    tbody += "<tr data-idx=" + idx + ">";
    tbody += `<td><input id="p${idx}" data-idx="${idx}" type="checkbox" ${position.checked ? "checked" : ""} /></td>`;

    for (const key of Object.keys(position)) {
      if (isNaN(position[key])) {
        if (position[key].match(/^\d{4}-\d{2}-\d{2}/)) {
          tbody += `<td><label for="p${idx}">${position[key].slice(0, 10)}</label></td>`;
        } else {
          tbody += `<td><label for="p${idx}">${position[key]}</label></td>`;
        }
      } else {
        const cls = [key];
        if (!isNaN(position[key])) cls.push("number");
        if (position[key] === 0) cls.push("zero");
        if (position[key] > 0) cls.push("positive");
        if (position[key] < 0) cls.push("negative");
        if (Math.abs(position[key]) > 1000) cls.push("k1");
        if (Math.abs(position[key]) > 10000) cls.push("k10");
        if (Math.abs(position[key]) > 100000) cls.push("k100");
        tbody += `<td class="${cls.join(" ")}"><label for="p${idx}">${round(position[key], 2)}</label></td>`;
      }
    }
    tbody += "</tr>";
  }
  tbodyContainer.innerHTML = tbody;

  const theadContainer = document.getElementById("positions-thead");
  let thead = "<tr>";
  thead += "<th></th>";
  for (const key of Object.keys(positions[0] ?? {})) {
    thead += `<th class="${key}">${key}</th>`;
  }
  thead += "</tr>";
  theadContainer.innerHTML = thead;
}

function calculateTotals() {
  const dividendsIncome = transactions.filter((t) => t.type === "Dividends").reduce((acc, t) => acc + (t.out ?? 0), 0);
  const dividendsTax = dividendsIncome * 0.14;
  document.getElementById("dividends-income").innerText = round(dividendsIncome, 2);
  document.getElementById("dividends-tax").innerText = round(dividendsTax, 2);
  const tradesIncome = trades.reduce((acc, t) => acc + (t.pl ?? 0), 0);
  const tradesTax = tradesIncome * 0.24;
  document.getElementById("trades-income").innerText = round(tradesIncome, 2);
  document.getElementById("trades-tax").innerText = round(tradesTax, 2);
  const positionsIncome = positions.filter((p) => p.checked).reduce((acc, p) => acc + (p.pl ?? 0), 0);
  const positionsTax = positionsIncome * 0.24;
  document.getElementById("positions-income").innerText = round(positionsIncome, 2);
  document.getElementById("positions-tax").innerText = round(positionsTax, 2);

  const totalIncome = dividendsIncome + tradesIncome + positionsIncome;
  const totalTax = dividendsTax + tradesTax + positionsTax;
  document.getElementById("total-income").innerText = round(totalIncome, 2);
  document.getElementById("total-tax").innerText = round(totalTax, 2);
}
