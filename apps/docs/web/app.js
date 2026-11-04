"use strict";
(() => {
  // apps/docs/sigil/app.sigil
  var app_default = '; B1 document service: reference implementation (Sigil).\n\n(type Id      (Int 0 9007199254740991))\n(type Size    (Int 0 1000000))\n(type Role    (var Viewer Editor Admin))\n(type Status  (var Draft Published Deleted))\n(type Op      (var Update Delete Publish))\n(type DocError (var NotAllowed Gone TooLong AlreadyPublished EmptyBody StoreFailed))\n\n(type Actor   (rec (id Id) (role Role)))\n(type Doc     (rec (id Id) (owner Id) (title Str :pii) (size Size) (status Status)))\n(type Request (rec (op Op) (title Str :pii) (size Size)))\n(type Receipt (rec (doc Id) (status Status) (size Size)))\n(type Applied (rec (actor Id) (doc Id) (op Op)))\n(type Refused (rec (actor Id) (doc Id) (op Op) (reason DocError)))\n\n(fn authorised\n  (in (a Actor) (d Doc) (op Op))\n  (out Bool)\n  (match a.role\n    (Viewer false)\n    (Editor (and (= a.id d.owner) (not (= op Publish))))\n    (Admin true)))\n\n(fn check\n  (in (a Actor) (d Doc) (r Request))\n  (out (Result Bool DocError))\n  (if (not (authorised a d r.op))\n    (err NotAllowed)\n    (if (= d.status Deleted)\n      (err Gone)\n      (match r.op\n        (Update (if (> r.size 50000) (err TooLong) (ok true)))\n        (Delete (ok true))\n        (Publish (if (= d.status Published)\n                   (err AlreadyPublished)\n                   (if (= d.size 0) (err EmptyBody) (ok true))))))))\n\n(fn apply\n  (in (d Doc) (r Request))\n  (out Doc)\n  (match r.op\n    (Update (Doc d.id d.owner r.title r.size d.status))\n    (Delete (Doc d.id d.owner d.title d.size Deleted))\n    (Publish (Doc d.id d.owner d.title d.size Published))))\n\n(fn handle-request\n  (in (actor Actor) (doc Doc) (req Request))\n  (out (Result Receipt DocError))\n  (needs store:docs audit)\n  (match (check actor doc req)\n    (err e (do (emit audit (Refused actor.id doc.id req.op e))\n               (err e)))\n    (ok _ (let [nd (apply doc req)]\n            (try (put store:docs doc.id nd) :on-err StoreFailed)\n            (emit audit (Applied actor.id doc.id req.op))\n            (ok (Receipt nd.id nd.status nd.size))))))\n\n(program docs\n  (targets server browser)\n  (entry handle-request\n    (bind store:docs (store (ns "docs/docs") (mode append)))\n    (bind audit      (audit))))\n\n; View model for the UI: what this actor may do with this document. Pure; the renderer is trusted shell code.\n(type View (rec (id Id) (title Str :pii) (size Size) (status Status) (can-update Bool) (can-delete Bool) (can-publish Bool)))\n\n(fn doc-view\n  (in (a Actor) (d Doc))\n  (out View)\n  (View d.id d.title d.size d.status\n        (and (authorised a d Update) (not (= d.status Deleted)))\n        (and (authorised a d Delete) (not (= d.status Deleted)))\n        (and (authorised a d Publish) (not (= d.status Deleted)) (not (= d.status Published)) (> d.size 0))))\n';

  // src/ast.ts
  var CONFS = ["public", "internal", "pii", "secret"];
  function emptyProgram() {
    return {
      types: /* @__PURE__ */ new Map(),
      fns: /* @__PURE__ */ new Map(),
      validators: /* @__PURE__ */ new Map(),
      binds: /* @__PURE__ */ new Map(),
      entries: [],
      targets: [],
      names: []
    };
  }
  function resolveType(p, t, seen = /* @__PURE__ */ new Set()) {
    while (t.k === "named") {
      if (seen.has(t.name)) throw new Error(`cyclic type ${t.name}`);
      seen.add(t.name);
      const d = p.types.get(t.name);
      if (!d) throw new Error(`unknown type ${t.name}`);
      t = d;
    }
    return t;
  }

  // src/caps.ts
  var CAP_OPS = {
    put: { kind: "store", arity: 3 },
    // (put handle key value) -> Result<Unit,_>
    get: { kind: "store", arity: 2 },
    post: { kind: "net", arity: 2 },
    // (post handle payload) -> Result<Unit,_>
    emit: { kind: "audit", arity: 2 },
    // (emit handle event) -> Unit
    fresh: { kind: "rand", arity: 1 }
    // (fresh handle) -> Int
  };
  function kindOfHandle(handle2) {
    const i = handle2.indexOf(":");
    return i < 0 ? handle2 : handle2.slice(0, i);
  }

  // src/sexpr.ts
  var SigilError = class extends Error {
    constructor(msg, pos) {
      super(pos ? `${pos.line}:${pos.col}: ${msg}` : msg);
      this.pos = pos;
      this.name = "SigilError";
    }
    pos;
  };
  var DELIM = /[\s()\[\]";]/;
  function readAll(src) {
    let i = 0;
    let line = 1;
    let col = 1;
    const pos = () => ({ line, col });
    const adv = () => {
      const c = src[i++];
      if (c === "\n") {
        line++;
        col = 1;
      } else col++;
      return c;
    };
    function skip() {
      for (; ; ) {
        const c = src[i];
        if (c === void 0) return;
        if (/\s/.test(c)) adv();
        else if (c === ";") {
          while (i < src.length && src[i] !== "\n") adv();
        } else return;
      }
    }
    function read() {
      skip();
      const p = pos();
      const c = src[i];
      if (c === "(" || c === "[") {
        adv();
        const close = c === "(" ? ")" : "]";
        const items = [];
        for (; ; ) {
          skip();
          if (i >= src.length) throw new SigilError(`unclosed '${c}'`, p);
          const d = src[i];
          if (d === close) {
            adv();
            break;
          }
          if (d === ")" || d === "]") throw new SigilError(`mismatched '${d}', expected '${close}'`, pos());
          items.push(read());
        }
        return { t: "list", items, bracket: c === "[", pos: p };
      }
      if (c === ")" || c === "]") throw new SigilError(`unexpected '${c}'`, p);
      if (c === '"') {
        adv();
        let s = "";
        for (; ; ) {
          if (i >= src.length) throw new SigilError("unterminated string", p);
          const d = adv();
          if (d === '"') break;
          if (d === "\\") {
            const e = adv();
            s += e === "n" ? "\n" : e === "t" ? "	" : e;
          } else s += d;
        }
        return { t: "str", v: s, pos: p };
      }
      let tok = "";
      while (i < src.length && !DELIM.test(src[i])) tok += adv();
      if (/^-?\d[\d_]*$/.test(tok)) return { t: "int", v: BigInt(tok.replace(/_/g, "")), pos: p };
      return { t: "sym", v: tok, pos: p };
    }
    const out = [];
    for (; ; ) {
      skip();
      if (i >= src.length) break;
      out.push(read());
    }
    return out;
  }
  function sexpToString(s) {
    switch (s.t) {
      case "int":
        return s.v.toString();
      case "str":
        return JSON.stringify(s.v);
      case "sym":
        return s.v;
      case "list": {
        const [o, c] = s.bracket ? ["[", "]"] : ["(", ")"];
        return o + s.items.map(sexpToString).join(" ") + c;
      }
    }
  }
  var isSym = (s, v) => !!s && s.t === "sym" && (v === void 0 || s.v === v);
  var isList = (s) => !!s && s.t === "list";
  var isKeyword = (s) => !!s && s.t === "sym" && s.v.startsWith(":") && s.v.length > 1;

  // src/parse.ts
  var fail = (msg, at) => {
    throw new SigilError(msg, at?.pos);
  };
  function sym(s, what, at) {
    if (!s || s.t !== "sym") return fail(`expected ${what}`, s ?? at);
    return s.v;
  }
  function parseType(s) {
    if (s.t === "sym") {
      switch (s.v) {
        case "Str":
          return { k: "str", validated: false };
        case "Int":
          return fail("Int needs bounds: write (Int lo hi), for example (Int 0 1000)", s);
        case "List":
          return fail("List needs an element type and bounds: (List T min max)", s);
        case "Bool":
          return { k: "bool" };
        case "Unit":
          return { k: "unit" };
        default:
          if (s.v.startsWith(":")) return fail(`unexpected keyword ${s.v} in type position`, s);
          return { k: "named", name: s.v };
      }
    }
    if (s.t !== "list" || s.items.length === 0) return fail("malformed type", s);
    const [head, ...rest] = s.items;
    const h = sym(head, "type constructor", s);
    switch (h) {
      case "Int": {
        if (rest.length !== 2 || rest[0].t !== "int" || rest[1].t !== "int") return fail("(Int lo hi) expects two integer literals", s);
        if (rest[0].v > rest[1].v) return fail("empty Int range", s);
        return { k: "int", lo: rest[0].v, hi: rest[1].v };
      }
      case "Str": {
        let validated = false;
        let max;
        for (let i = 0; i < rest.length; i++) {
          const r = rest[i];
          if (!isKeyword(r)) return fail("(Str ...) takes only flags (:validated, :max N)", r);
          if (r.v === ":validated") validated = true;
          else if (r.v === ":max") {
            const n = rest[++i];
            if (!n || n.t !== "int" || n.v < 0n) return fail("(Str :max N) needs a non-negative integer literal", r);
            max = Number(n.v);
          } else return fail(`unknown Str flag ${r.v}`, s);
        }
        return max === void 0 ? { k: "str", validated } : { k: "str", validated, max };
      }
      case "var": {
        if (rest.length === 0) return fail("(var ...) needs at least one case", s);
        return { k: "enum", cases: rest.map((r) => sym(r, "case name", s)) };
      }
      case "rec":
        return { k: "rec", fields: rest.map(parseField) };
      case "List": {
        if (rest.length !== 3 || rest[1].t !== "int" || rest[2].t !== "int") return fail("(List T min max)", s);
        const min = Number(rest[1].v);
        const max = Number(rest[2].v);
        if (min > max || min < 0) return fail("bad list length range", s);
        return { k: "list", elem: parseType(rest[0]), min, max };
      }
      case "Result": {
        if (rest.length !== 2) return fail("(Result Ok Err)", s);
        return { k: "result", ok: parseType(rest[0]), err: parseType(rest[1]) };
      }
      default:
        return fail(`unknown type constructor ${h}`, s);
    }
  }
  function parseField(s) {
    if (s.t !== "list" || s.items.length < 2) return fail("field is (name Type flags...)", s);
    const name = sym(s.items[0], "field name", s);
    const type = parseType(s.items[1]);
    let conf = "public";
    let control = false;
    for (const f of s.items.slice(2)) {
      if (!isKeyword(f)) return fail("field flags are keywords", f);
      const w = f.v.slice(1);
      if (CONFS.includes(w)) conf = w;
      else if (w === "control") control = true;
      else return fail(`unknown field flag ${f.v}`, f);
    }
    return { name, type, conf, control };
  }
  function parseExpr(s) {
    switch (s.t) {
      case "int":
        return { k: "int", v: s.v };
      case "str":
        return { k: "str", v: s.v };
      case "sym": {
        if (s.v === "true") return { k: "bool", v: true };
        if (s.v === "false") return { k: "bool", v: false };
        if (s.v.startsWith(":")) return fail(`unexpected keyword ${s.v}`, s);
        const parts = s.v.split(".");
        if (parts.some((p) => p === "")) return fail(`bad identifier ${s.v}`, s);
        return { k: "var", name: parts[0], path: parts.slice(1) };
      }
      case "list":
        return parseForm(s);
    }
  }
  function parseForm(s) {
    if (s.items.length === 0) return fail("empty form", s);
    const head = s.items[0];
    const h = sym(head, "function or form name", s);
    const rest = s.items.slice(1);
    switch (h) {
      case "let": {
        const bl = rest[0];
        if (!isList(bl) || bl.items.length % 2 !== 0) return fail("(let [name expr ...] body...)", s);
        const binds = [];
        for (let i = 0; i < bl.items.length; i += 2) {
          binds.push({ name: sym(bl.items[i], "binding name", bl), value: parseExpr(bl.items[i + 1]) });
        }
        if (rest.length < 2) return fail("let needs a body", s);
        return { k: "let", binds, body: rest.slice(1).map(parseExpr) };
      }
      case "match": {
        if (rest.length < 2) return fail("(match scrutinee (Tag body)...)", s);
        const arms = rest.slice(1).map((a) => {
          if (!isList(a) || a.items.length !== 2 && a.items.length !== 3) return fail("match arm is (Tag body) or (Tag bind body)", a);
          const tag = sym(a.items[0], "arm tag", a);
          if (a.items.length === 2) return { tag, bind: null, body: parseExpr(a.items[1]) };
          return { tag, bind: sym(a.items[1], "binder", a), body: parseExpr(a.items[2]) };
        });
        return { k: "match", scrut: parseExpr(rest[0]), arms };
      }
      case "if": {
        if (rest.length !== 3) return fail("(if cond then else)", s);
        return { k: "if", cond: parseExpr(rest[0]), then: parseExpr(rest[1]), else: parseExpr(rest[2]) };
      }
      case "fn": {
        const ps = rest[0];
        if (!isList(ps) || rest.length !== 2) return fail("lambda is (fn (params...) body)", s);
        return { k: "lam", params: ps.items.map((p) => sym(p, "parameter", ps)), body: parseExpr(rest[1]) };
      }
      case "do": {
        if (rest.length === 0) return fail("empty do", s);
        return { k: "do", body: rest.map(parseExpr) };
      }
      case "declassify": {
        if (rest.length !== 2 || !isSym(rest[0]) || rest[0].v.startsWith(":") || rest[0].v.includes(".")) return fail("(declassify name expr), where name is declared in the policy", s);
        return { k: "call", fn: "declassify", args: [{ k: "var", name: rest[0].v, path: [] }, parseExpr(rest[1])], kw: [] };
      }
      case "try": {
        if (rest.length !== 3 || !isSym(rest[1], ":on-err")) return fail("(try expr :on-err Variant)", s);
        return { k: "try", expr: parseExpr(rest[0]), onErr: sym(rest[2], "error variant", s) };
      }
      default: {
        const args = [];
        const kw = [];
        for (let i = 0; i < rest.length; i++) {
          const r = rest[i];
          if (isKeyword(r)) {
            if (i + 1 >= rest.length) return fail(`keyword ${r.v} has no value`, r);
            kw.push({ name: r.v.slice(1), value: parseExpr(rest[++i]) });
          } else {
            if (kw.length) return fail("positional argument after keyword argument", r);
            args.push(parseExpr(r));
          }
        }
        return { k: "call", fn: h, args, kw };
      }
    }
  }
  var FN_CLAUSES = /* @__PURE__ */ new Set(["in", "out", "needs", "declassifies", "requires", "ensures"]);
  function parseFn(s) {
    const name = sym(s.items[1], "function name", s);
    const fn = { name, params: [], out: { k: "unit" }, needs: [], declassifies: [], requires: [], ensures: [], body: { k: "int", v: 0n } };
    let i = 2;
    let sawOut = false;
    for (; i < s.items.length; i++) {
      const c = s.items[i];
      if (!isList(c) || !isSym(c.items[0]) || !FN_CLAUSES.has(c.items[0].v)) break;
      const tag = c.items[0].v;
      const body = c.items.slice(1);
      switch (tag) {
        case "in":
          fn.params = body.map((p) => {
            if (!isList(p) || p.items.length !== 2) return fail("parameter is (name Type)", p);
            return { name: sym(p.items[0], "parameter name", p), type: parseType(p.items[1]) };
          });
          break;
        case "out":
          if (body.length !== 1) fail("(out Type)", c);
          fn.out = parseType(body[0]);
          sawOut = true;
          break;
        case "needs":
          fn.needs = body.map((b) => sym(b, "capability handle", c));
          break;
        case "declassifies":
          fn.declassifies = body.map((b) => sym(b, "declassifier name", c));
          break;
        case "requires":
          fn.requires.push(...body.map(parseExpr));
          break;
        case "ensures":
          fn.ensures.push(...body.map(parseExpr));
          break;
      }
    }
    if (!sawOut) fail(`fn ${name} needs an (out Type) clause`, s);
    const bodyForms = s.items.slice(i);
    if (bodyForms.length === 0) fail(`fn ${name} has no body`, s);
    const exprs = bodyForms.map(parseExpr);
    fn.body = exprs.length === 1 ? exprs[0] : { k: "do", body: exprs };
    return fn;
  }
  function parseProgram(src, into = emptyProgram()) {
    const p = into;
    for (const form of readAll(src)) {
      if (!isList(form) || !isSym(form.items[0])) {
        fail("top-level form must be a list starting with a keyword", form);
        continue;
      }
      const head = form.items[0].v;
      switch (head) {
        case "type": {
          const name = sym(form.items[1], "type name", form);
          if (p.types.has(name)) fail(`duplicate type ${name}`, form);
          p.types.set(name, parseType(form.items[2]));
          break;
        }
        case "fn": {
          const fn = parseFn(form);
          if (fn.name === "declassify") fail("declassify is a reserved form name", form);
          if (p.fns.has(fn.name)) fail(`duplicate fn ${fn.name}`, form);
          p.fns.set(fn.name, fn);
          break;
        }
        case "validator": {
          const name = sym(form.items[1], "validator name", form);
          let param = "s";
          let out;
          let regex;
          const samples = [];
          for (const c of form.items.slice(2)) {
            if (!isList(c) || !isSym(c.items[0])) {
              fail("validator clause", c);
              continue;
            }
            const tag = c.items[0].v;
            if (tag === "in") {
              const pr = c.items[1];
              if (!isList(pr)) fail("(in (name Str))", c);
              else param = sym(pr.items[0], "param", pr);
            } else if (tag === "out") out = parseType(c.items[1]);
            else if (tag === "sample") {
              for (const x of c.items.slice(1)) {
                if (x.t !== "str") fail('(sample "..." ...)', x);
                else samples.push(x.v);
              }
            } else if (tag === "regex") {
              const r = c.items[1];
              if (!r || r.t !== "str") fail('(regex "...")', c);
              else regex = r.v;
            } else fail(`unknown validator clause ${tag}`, c);
          }
          if (!out || regex === void 0) return fail(`validator ${name} needs out and regex`, form);
          p.validators.set(name, { name, param, out, regex, samples });
          break;
        }
        case "program": {
          p.names.push(sym(form.items[1], "program name", form));
          for (const c of form.items.slice(2)) {
            if (!isList(c) || !isSym(c.items[0])) {
              fail("program clause", c);
              continue;
            }
            const tag = c.items[0].v;
            if (tag === "targets") p.targets.push(...c.items.slice(1).map((t) => sym(t, "target", c)));
            else if (tag === "entry") {
              p.entries.push(sym(c.items[1], "entry function", c));
              for (const b of c.items.slice(2)) {
                if (!isList(b) || !isSym(b.items[0], "bind")) {
                  fail("(bind handle (kind caveats...))", b);
                  continue;
                }
                const handle2 = sym(b.items[1], "handle", b);
                const spec = b.items[2];
                if (!isList(spec)) {
                  fail("bind needs (kind caveats...)", b);
                  continue;
                }
                const kind = sym(spec.items[0], "capability kind", spec);
                if (kindOfHandle(handle2) !== kind) fail(`handle ${handle2} must be a ${kind} (name it ${kind}:name)`, b);
                const caveats = {};
                for (const cv of spec.items.slice(1)) {
                  if (isSym(cv)) caveats[cv.v] = [];
                  else if (isList(cv)) caveats[sym(cv.items[0], "caveat", cv)] = cv.items.slice(1).map((x) => x.t === "str" ? x.v : sexpToString(x));
                  else fail("bad caveat", cv);
                }
                p.binds.set(handle2, { handle: handle2, kind, caveats });
              }
            } else fail(`unknown program clause ${tag}`, c);
          }
          break;
        }
        default:
          fail(`unknown top-level form ${head}`, form);
      }
    }
    return p;
  }

  // src/print/sexp.ts
  function printExpr(e) {
    switch (e.k) {
      case "int":
        return e.v.toString();
      case "str":
        return JSON.stringify(e.v);
      case "bool":
        return e.v ? "true" : "false";
      case "var":
        return [e.name, ...e.path].join(".");
      case "call": {
        const parts = [e.fn, ...e.args.map(printExpr), ...e.kw.flatMap((k) => [`:${k.name}`, printExpr(k.value)])];
        return `(${parts.join(" ")})`;
      }
      case "let":
        return `(let [${e.binds.map((b) => `${b.name} ${printExpr(b.value)}`).join(" ")}] ${e.body.map(printExpr).join(" ")})`;
      case "match":
        return `(match ${printExpr(e.scrut)} ${e.arms.map((a) => a.bind ? `(${a.tag} ${a.bind} ${printExpr(a.body)})` : `(${a.tag} ${printExpr(a.body)})`).join(" ")})`;
      case "if":
        return `(if ${printExpr(e.cond)} ${printExpr(e.then)} ${printExpr(e.else)})`;
      case "lam":
        return `(fn (${e.params.join(" ")}) ${printExpr(e.body)})`;
      case "do":
        return `(do ${e.body.map(printExpr).join(" ")})`;
      case "try":
        return `(try ${printExpr(e.expr)} :on-err ${e.onErr})`;
    }
  }

  // src/interp.ts
  var UNIT = null;
  var enumVal = (tag) => ({ $: "enum", tag });
  var okVal = (v) => ({ $: "ok", v });
  var errVal = (v) => ({ $: "err", v });
  var ContractViolation = class extends Error {
    constructor(kind, msg) {
      super(msg);
      this.kind = kind;
      this.name = "ContractViolation";
    }
    kind;
  };
  var RuntimeFault = class extends Error {
  };
  var EarlyReturn = class {
    constructor(value) {
      this.value = value;
    }
    value;
  };
  function showVal(v) {
    if (v === null) return "unit";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return `[${v.map(showVal).join(", ")}]`;
    switch (v.$) {
      case "enum":
        return v.tag;
      case "ok":
        return `(ok ${showVal(v.v)})`;
      case "err":
        return `(err ${showVal(v.v)})`;
      case "rec":
        return `${v.type}{${Object.entries(v.fields).map(([k, x]) => `${k}: ${showVal(x)}`).join(", ")}}`;
    }
  }
  function eqVal(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => eqVal(x, b[i]));
    }
    if (a.$ !== b.$) return false;
    switch (a.$) {
      case "enum":
        return a.tag === b.tag;
      case "ok":
      case "err":
        return eqVal(a.v, b.v);
      case "rec": {
        const bb = b;
        const ka = Object.keys(a.fields);
        return a.type === bb.type && ka.length === Object.keys(bb.fields).length && ka.every((k) => k in bb.fields && eqVal(a.fields[k], bb.fields[k]));
      }
    }
  }
  function mulberry32(seed2) {
    let a = seed2 >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var Host = class {
    log = [];
    failing = /* @__PURE__ */ new Set();
    // "handle.op"
    rnd;
    constructor(seed2 = 1) {
      this.rnd = mulberry32(seed2);
    }
    fail(handle2, op) {
      this.failing.add(`${handle2}.${op}`);
    }
    sent(handle2) {
      return this.log.filter((o) => o.handle === handle2 && o.op === "post" && o.ok).map((o) => o.args[0]);
    }
    stored(handle2) {
      return this.log.filter((o) => o.handle === handle2 && o.op === "put" && o.ok).map((o) => o.args[1]);
    }
    emitted(handle2) {
      return this.log.filter((o) => o.handle === handle2 && o.op === "emit" && o.ok).map((o) => o.args[0]);
    }
    call(handle2, op, args) {
      if (this.failing.has(`${handle2}.${op}`)) {
        this.log.push({ handle: handle2, op, args, ok: false });
        return errVal(UNIT);
      }
      this.log.push({ handle: handle2, op, args, ok: true });
      switch (op) {
        case "put":
        case "post":
          return okVal(UNIT);
        case "emit":
          return UNIT;
        case "fresh":
          return BigInt(Math.floor(this.rnd() * Number.MAX_SAFE_INTEGER));
        default:
          throw new RuntimeFault(`host: unsupported op ${op}`);
      }
    }
  };
  var Interp = class {
    // "fn#i" -> number of passing runtime checks
    constructor(prog, host, opts = { contracts: true, fuel: 5e6 }) {
      this.prog = prog;
      this.host = host;
      this.opts = opts;
      this.fuel = opts.fuel;
    }
    prog;
    host;
    opts;
    fuel;
    ensuresStats = /* @__PURE__ */ new Map();
    // --- type conformance (runtime contract check) -------------------------------
    checkType(v, t, where) {
      if (!this.opts.contracts) return;
      const r = resolveType(this.prog, t);
      const bad = (m) => {
        throw new ContractViolation("type", `${where}: ${m}`);
      };
      switch (r.k) {
        case "int":
          if (typeof v !== "bigint") return bad(`expected Int, got ${showVal(v)}`);
          if (v < r.lo || v > r.hi) return bad(`${v} outside [${r.lo}, ${r.hi}]`);
          return;
        case "str":
          if (typeof v !== "string") return bad(`expected Str, got ${showVal(v)}`);
          if (r.max !== void 0 && Array.from(v).length > r.max) bad(`string of ${Array.from(v).length} characters exceeds :max ${r.max}`);
          return;
        case "bool":
          if (typeof v !== "boolean") bad("expected Bool");
          return;
        case "unit":
          return;
        case "enum":
          if (!v || typeof v !== "object" || Array.isArray(v) || v.$ !== "enum" || !r.cases.includes(v.tag)) bad(`expected one of ${r.cases.join("|")}, got ${showVal(v)}`);
          return;
        case "list":
          if (!Array.isArray(v)) return bad("expected list");
          if (v.length < r.min || v.length > r.max) return bad(`length ${v.length} outside [${r.min}, ${r.max}]`);
          v.forEach((x, i) => this.checkType(x, r.elem, `${where}[${i}]`));
          return;
        case "rec":
          if (!v || typeof v !== "object" || Array.isArray(v) || v.$ !== "rec") return bad(`expected record, got ${showVal(v)}`);
          for (const f of r.fields) this.checkType(v.fields[f.name], f.type, `${where}.${f.name}`);
          return;
        case "result":
          if (!v || typeof v !== "object" || Array.isArray(v) || v.$ !== "ok" && v.$ !== "err") return bad("expected Result");
          this.checkType(v.v, v.$ === "ok" ? r.ok : r.err, `${where}.${v.$}`);
          return;
        default:
          return;
      }
    }
    // --- function calls ----------------------------------------------------------
    callFn(name, args) {
      const f = this.prog.fns.get(name);
      if (!f) throw new RuntimeFault(`unknown function ${name}`);
      return this.apply(f, args);
    }
    apply(f, args) {
      if (args.length !== f.params.length) throw new RuntimeFault(`${f.name}: arity ${f.params.length} expected, got ${args.length}`);
      const env = /* @__PURE__ */ new Map();
      f.params.forEach((p, i) => {
        this.checkType(args[i], p.type, `${f.name}(${p.name})`);
        env.set(p.name, args[i]);
      });
      if (this.opts.contracts) {
        for (const r of f.requires) {
          if (this.eval(r, env) !== true) throw new ContractViolation("requires", `${f.name}: requires ${printExpr(r)} violated`);
        }
      }
      let out;
      try {
        out = this.eval(f.body, env);
      } catch (e) {
        if (e instanceof EarlyReturn) out = e.value;
        else throw e;
      }
      this.checkType(out, f.out, `${f.name}.out`);
      if (this.opts.contracts && f.ensures.length) {
        const env2 = new Map(env);
        env2.set("out", out);
        for (const [i, en] of f.ensures.entries()) {
          if (this.eval(en, env2) !== true) {
            throw new ContractViolation("ensures", `${f.name}: ensures ${printExpr(en)} violated (out=${showVal(out)}, ${[...env].map(([k, v]) => `${k}=${showVal(v)}`).join(", ").slice(0, 200)})`);
          }
          const key = `${f.name}#${i}`;
          this.ensuresStats.set(key, (this.ensuresStats.get(key) ?? 0) + 1);
        }
      }
      return out;
    }
    // --- expressions -------------------------------------------------------------
    eval(e, env) {
      if (--this.fuel < 0) throw new RuntimeFault("out of fuel");
      switch (e.k) {
        case "int":
          return e.v;
        case "str":
          return e.v;
        case "bool":
          return e.v;
        case "var":
          return this.evalVar(e, env);
        case "let": {
          const env2 = new Map(env);
          for (const b of e.binds) env2.set(b.name, this.eval(b.value, env2));
          let last = UNIT;
          for (const b of e.body) last = this.eval(b, env2);
          return last;
        }
        case "do": {
          let last = UNIT;
          for (const b of e.body) last = this.eval(b, env);
          return last;
        }
        case "try": {
          const r = this.eval(e.expr, env);
          if (r && typeof r === "object" && !Array.isArray(r) && r.$ === "err") throw new EarlyReturn(errVal(enumVal(e.onErr)));
          if (r && typeof r === "object" && !Array.isArray(r) && r.$ === "ok") return r.v;
          throw new RuntimeFault(`try applied to a non-Result: ${showVal(r)}`);
        }
        case "if": {
          const c = this.eval(e.cond, env);
          if (typeof c !== "boolean") throw new RuntimeFault("if condition is not a Bool");
          return this.eval(c ? e.then : e.else, env);
        }
        case "match":
          return this.evalMatch(e, env);
        case "lam":
          throw new RuntimeFault("lambda is not a first-class value");
        case "call":
          return this.evalCall(e, env);
      }
    }
    evalVar(e, env) {
      let cur;
      if (env.has(e.name)) cur = env.get(e.name);
      else if (e.path.length === 0 && this.isEnumCase(e.name)) return enumVal(e.name);
      else if (e.path.length === 0 && (this.prog.binds.has(e.name) || e.name.includes(":") || e.name === "audit" || e.name === "rand")) return e.name;
      else throw new RuntimeFault(`unbound name ${e.name}`);
      for (const f of e.path) {
        if (!cur || typeof cur !== "object" || Array.isArray(cur) || cur.$ !== "rec" || !(f in cur.fields)) throw new RuntimeFault(`no field ${f} on ${showVal(cur)}`);
        cur = cur.fields[f];
      }
      return cur;
    }
    isEnumCase(name) {
      for (const t of this.prog.types.values()) if (t.k === "enum" && t.cases.includes(name)) return true;
      return false;
    }
    evalMatch(e, env) {
      const s = this.eval(e.scrut, env);
      let tag;
      let payload = UNIT;
      if (s && typeof s === "object" && !Array.isArray(s)) {
        if (s.$ === "enum") tag = s.tag;
        else if (s.$ === "ok" || s.$ === "err") {
          tag = s.$;
          payload = s.v;
        }
      }
      if (tag === void 0) throw new RuntimeFault(`cannot match on ${showVal(s)}`);
      const arm = e.arms.find((a) => a.tag === tag);
      if (!arm) throw new RuntimeFault(`non-exhaustive match: no arm for ${tag}`);
      const env2 = new Map(env);
      if (arm.bind) env2.set(arm.bind, payload);
      return this.eval(arm.body, env2);
    }
    lambda(e, env) {
      if (e.k !== "lam") throw new RuntimeFault("expected a lambda");
      return { params: e.params, body: e.body, env };
    }
    evalCall(e, env) {
      const name = e.fn;
      if (name === "declassify" && e.args.length === 2) return this.eval(e.args[1], env);
      if (name in CAP_OPS) {
        const h = this.eval(e.args[0], env);
        if (typeof h !== "string") throw new RuntimeFault(`${name}: first argument must be a capability handle`);
        const rest = e.args.slice(1).map((a) => this.eval(a, env));
        return this.host.call(h, name, rest);
      }
      const td = this.prog.types.get(name);
      if (td) {
        const r = resolveType(this.prog, td);
        if (r.k !== "rec") throw new RuntimeFault(`${name} is not a record type`);
        const fields = {};
        if (e.args.length) {
          if (e.args.length !== r.fields.length) {
            throw new RuntimeFault(`${name} has ${r.fields.length} field(s) (${r.fields.map((f) => f.name).join(", ")}) but is built with ${e.args.length} argument(s): ${printExpr(e)}. If this is in glossary.sigil, the program changed the shape of a type that the human-owned glossary or README fixes; restore the type instead of editing the glossary`);
          }
          r.fields.forEach((f, i) => fields[f.name] = this.eval(e.args[i], env));
        } else {
          for (const f of r.fields) {
            const k = e.kw.find((x) => x.name === f.name);
            if (!k) throw new RuntimeFault(`${name}: missing field ${f.name}`);
            fields[f.name] = this.eval(k.value, env);
          }
        }
        const rec = { $: "rec", type: name, fields };
        this.checkType(rec, td, name);
        return rec;
      }
      const uf = this.prog.fns.get(name);
      if (uf) return this.apply(uf, e.args.map((a) => this.eval(a, env)));
      return this.builtin(e, env);
    }
    num(v, what) {
      if (typeof v !== "bigint") throw new RuntimeFault(`${what}: expected Int, got ${showVal(v)}`);
      return v;
    }
    builtin(e, env) {
      const name = e.fn;
      if (name === "map" || name === "filter") {
        const xs = this.eval(e.args[0], env);
        if (!Array.isArray(xs)) throw new RuntimeFault(`${name}: expected a list`);
        const c = this.lambda(e.args[1], env);
        const run = (x) => {
          const env2 = new Map(c.env);
          env2.set(c.params[0], x);
          return this.eval(c.body, env2);
        };
        return name === "map" ? xs.map(run) : xs.filter((x) => run(x) === true);
      }
      if (name === "sort") {
        const xs = this.eval(e.args[0], env);
        if (!Array.isArray(xs)) throw new RuntimeFault("sort: expected a list");
        const c = this.lambda(e.args[1], env);
        if (c.params.length !== 2) throw new RuntimeFault("sort: lambda needs two parameters (a b)");
        const before = (a2, b) => {
          const env2 = new Map(c.env);
          env2.set(c.params[0], a2);
          env2.set(c.params[1], b);
          return this.eval(c.body, env2) === true;
        };
        const msort = (v) => {
          if (v.length <= 1) return v;
          const mid = v.length >> 1;
          const l = msort(v.slice(0, mid));
          const r = msort(v.slice(mid));
          const out = [];
          let i = 0;
          let j = 0;
          while (i < l.length && j < r.length) out.push(before(r[j], l[i]) ? r[j++] : l[i++]);
          while (i < l.length) out.push(l[i++]);
          while (j < r.length) out.push(r[j++]);
          return out;
        };
        return msort(xs);
      }
      if (name === "fold") {
        const [xsE, tE, initE, fE] = e.args;
        if (e.args.length !== 4 || tE.k !== "var" || !this.prog.types.has(tE.name)) throw new RuntimeFault("fold: expected (fold list Type init (fn (acc x) body))");
        const xs = this.eval(xsE, env);
        if (!Array.isArray(xs)) throw new RuntimeFault("fold: expected a list");
        const c = this.lambda(fE, env);
        if (c.params.length !== 2) throw new RuntimeFault("fold: lambda needs two parameters (acc x)");
        const T = { k: "named", name: tE.name };
        let acc = this.eval(initE, env);
        this.checkType(acc, T, "fold initial value");
        xs.forEach((x, i) => {
          const env2 = new Map(c.env);
          env2.set(c.params[0], acc);
          env2.set(c.params[1], x);
          acc = this.eval(c.body, env2);
          this.checkType(acc, T, `fold step ${i}`);
        });
        return acc;
      }
      if (name === "and") {
        for (const a2 of e.args) if (this.eval(a2, env) !== true) return false;
        return true;
      }
      if (name === "or") {
        for (const a2 of e.args) if (this.eval(a2, env) === true) return true;
        return false;
      }
      const a = e.args.map((x) => this.eval(x, env));
      switch (name) {
        case "add":
          return this.num(a[0], "add") + this.num(a[1], "add");
        case "sub":
          return this.num(a[0], "sub") - this.num(a[1], "sub");
        case "mul":
          return this.num(a[0], "mul") * this.num(a[1], "mul");
        case "div-floor": {
          const x = this.num(a[0], "div-floor");
          const y = this.num(a[1], "div-floor");
          if (y === 0n) throw new RuntimeFault("division by zero");
          const q = x / y;
          return x % y !== 0n && x % y < 0n !== y < 0n ? q - 1n : q;
        }
        case "neg":
          return -this.num(a[0], "neg");
        case "min":
          return this.num(a[0], "min") < this.num(a[1], "min") ? a[0] : a[1];
        case "max":
          return this.num(a[0], "max") > this.num(a[1], "max") ? a[0] : a[1];
        case "sum": {
          if (!Array.isArray(a[0])) throw new RuntimeFault("sum: expected a list");
          return a[0].reduce((s, x) => s + this.num(x, "sum"), 0n);
        }
        case "len":
          if (!Array.isArray(a[0])) throw new RuntimeFault("len: expected a list");
          return BigInt(a[0].length);
        case "chars":
          if (typeof a[0] !== "string") throw new RuntimeFault("chars: expected a Str");
          return Array.from(a[0]).map((c) => BigInt(c.codePointAt(0)));
        case "from-chars": {
          if (!Array.isArray(a[0])) throw new RuntimeFault("from-chars: expected a list of code points");
          return a[0].map((c) => {
            const n = this.num(c, "from-chars");
            if (n < 0n || n > 1114111n) throw new RuntimeFault(`from-chars: ${n} is not a code point`);
            return String.fromCodePoint(Number(n));
          }).join("");
        }
        case "append":
          if (!Array.isArray(a[0])) throw new RuntimeFault("append: expected a list");
          return [...a[0], a[1]];
        case "take":
        case "drop": {
          if (!Array.isArray(a[0])) throw new RuntimeFault(`${name}: expected a list`);
          const n = this.num(a[1], name);
          const k = n < 0n ? 0 : n > BigInt(a[0].length) ? a[0].length : Number(n);
          return name === "take" ? a[0].slice(0, k) : a[0].slice(k);
        }
        case "at": {
          if (!Array.isArray(a[0])) throw new RuntimeFault("at: expected a list");
          const i = this.num(a[1], "at");
          return i >= 0n && i < BigInt(a[0].length) ? a[0][Number(i)] : a[2];
        }
        case "text":
          return a.map((x) => typeof x === "string" ? x : showVal(x)).join("");
        case "money": {
          const c = this.num(a[0], "money");
          const abs = c < 0n ? -c : c;
          return `${c < 0n ? "-" : ""}$${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
        }
        case "list":
          return a;
        case "=":
          return eqVal(a[0], a[1]);
        case "<=":
        case "<":
        case ">=":
        case ">": {
          for (let i = 0; i + 1 < a.length; i++) {
            const x = this.num(a[i], name);
            const y = this.num(a[i + 1], name);
            const ok = name === "<=" ? x <= y : name === "<" ? x < y : name === ">=" ? x >= y : x > y;
            if (!ok) return false;
          }
          return true;
        }
        case "not":
          return a[0] !== true;
        case "ok":
          return okVal(a[0]);
        case "err":
          return errVal(a[0]);
        case "sent":
          return this.host.sent(a[0]);
        case "stored":
          return this.host.stored(a[0]);
        case "emitted":
          return this.host.emitted(a[0]);
        default:
          throw new RuntimeFault(`unknown function ${name}`);
      }
    }
  };

  // experiments/lib/json.ts
  var show = (v, n = 240) => {
    let s;
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
    return s.length > n ? s.slice(0, n) + "..." : s;
  };
  function encodeVal(v, path = "$") {
    if (v === null) return null;
    if (typeof v === "bigint") {
      if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${path}: integer beyond 2^53`);
      return Number(v);
    }
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.map((x, i) => encodeVal(x, `${path}[${i}]`));
    switch (v.$) {
      case "enum":
        return v.tag;
      case "ok":
        return { ok: encodeVal(v.v, `${path}.ok`) };
      case "err":
        return { err: encodeVal(v.v, `${path}.err`) };
      case "rec": {
        const o = {};
        for (const [k, x] of Object.entries(v.fields)) o[k] = encodeVal(x, `${path}.${k}`);
        return o;
      }
    }
  }
  function decodeVal(prog, t, j, path = "$", name = "") {
    if (t.k === "named") return decodeVal(prog, resolveType(prog, t), j, path, t.name);
    const bad = (m) => {
      throw new Error(`${path}: ${m}`);
    };
    switch (t.k) {
      case "int":
        if (typeof j !== "number" || !Number.isInteger(j)) return bad(`expected integer, got ${show(j, 40)}`);
        return BigInt(j);
      case "str":
        return typeof j === "string" ? j : bad("expected string");
      case "bool":
        return typeof j === "boolean" ? j : bad("expected boolean");
      case "unit":
        return null;
      case "enum":
        if (typeof j !== "string" || !t.cases.includes(j)) return bad(`expected one of ${t.cases.join("|")}, got ${show(j, 40)}`);
        return enumVal(j);
      case "list":
        if (!Array.isArray(j)) return bad("expected array");
        return j.map((x, i) => decodeVal(prog, t.elem, x, `${path}[${i}]`));
      case "rec": {
        if (j === null || typeof j !== "object" || Array.isArray(j)) return bad("expected object");
        const fields = {};
        for (const f of t.fields) {
          if (!(f.name in j)) return bad(`missing field ${f.name}`);
          fields[f.name] = decodeVal(prog, f.type, j[f.name], `${path}.${f.name}`);
        }
        return { $: "rec", type: name, fields };
      }
      case "result": {
        if (j === null || typeof j !== "object" || Array.isArray(j)) return bad("expected {ok} or {err}");
        if ("ok" in j) return okVal(decodeVal(prog, t.ok, j.ok, `${path}.ok`));
        if ("err" in j) return errVal(decodeVal(prog, t.err, j.err, `${path}.err`));
        return bad("expected {ok} or {err}");
      }
      default:
        return bad(`unsupported type ${t.k}`);
    }
  }

  // apps/docs/src/engine.ts
  var AdapterHost = class extends Host {
    constructor(store, audit) {
      super();
      this.store = store;
      this.audit = audit;
    }
    store;
    audit;
    call(handle2, op, args) {
      if (handle2 === "store:docs" && op === "put") {
        const ok = this.store.put(Number(args[0]), encodeVal(args[1]));
        this.log.push({ handle: handle2, op, args, ok });
        return ok ? okVal(UNIT) : errVal(UNIT);
      }
      if (handle2 === "audit" && op === "emit") {
        this.audit.emit(encodeVal(args[0]));
        this.log.push({ handle: handle2, op, args, ok: true });
        return UNIT;
      }
      throw new RuntimeFault(`host: no adapter for ${handle2}.${op}`);
    }
  };
  var DocsEngine = class {
    constructor(source, store, audit) {
      this.store = store;
      this.audit = audit;
      this.prog = parseProgram(source);
    }
    store;
    audit;
    prog;
    run(fn, args) {
      const f = this.prog.fns.get(fn);
      if (!f) throw new Error(`program has no function ${fn}`);
      const vals = f.params.map((p, i) => decodeVal(this.prog, p.type, args[i], p.name));
      return new Interp(this.prog, new AdapterHost(this.store, this.audit)).callFn(fn, vals);
    }
    /** The program's view model for this actor and document. */
    view(actor2, docId) {
      const doc = this.store.get(docId);
      if (doc === null) return null;
      return encodeVal(this.run("doc-view", [actor2, doc]));
    }
    act(actor2, docId, op, payload = {}) {
      const doc = this.store.get(docId);
      if (doc === null) return { kind: "not-found" };
      const req = { op, title: payload.title ?? "", size: payload.size ?? 0 };
      let out;
      try {
        out = encodeVal(this.run("handle-request", [actor2, doc, req]));
      } catch (e) {
        if (e instanceof Error && !(e instanceof RuntimeFault) && /expected|outside|missing/.test(e.message)) return { kind: "bad-input", message: e.message };
        throw e;
      }
      const r = out;
      return r.ok ? { kind: "ok", receipt: r.ok } : { kind: "refused", reason: r.err };
    }
    auditLog() {
      return this.audit.all();
    }
  };
  var DEMO_DOCS = [
    { id: 1, owner: 10, title: "Q3 plan", size: 800, status: "Draft" },
    { id: 2, owner: 11, title: "Handbook", size: 12e3, status: "Published" },
    { id: 3, owner: 10, title: "Empty draft", size: 0, status: "Draft" }
  ];
  function seed(store, docs = DEMO_DOCS) {
    for (const d of docs) store.put(d.id, d);
  }

  // apps/docs/src/adapters.ts
  var WebDocStore = class {
    constructor(kv, prefix = "docs:") {
      this.kv = kv;
      this.prefix = prefix;
    }
    kv;
    prefix;
    get(id) {
      const s = this.kv.getItem(this.prefix + id);
      return s === null ? null : JSON.parse(s);
    }
    put(id, value) {
      try {
        this.kv.setItem(this.prefix + id, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }
  };
  var WebAuditLog = class {
    constructor(kv, key = "audit") {
      this.kv = kv;
      this.key = key;
    }
    kv;
    key;
    emit(event) {
      this.kv.setItem(this.key, JSON.stringify([...this.all(), event]));
    }
    all() {
      const s = this.kv.getItem(this.key);
      return s === null ? [] : JSON.parse(s);
    }
  };

  // apps/docs/src/routes.ts
  var STATUS_OF = {
    NotAllowed: 403,
    Gone: 410,
    TooLong: 413,
    AlreadyPublished: 409,
    EmptyBody: 422,
    StoreFailed: 503
  };
  var ROUTES = [
    { method: "GET", pattern: /^\/docs\/(\d+)$/, kind: "view" },
    { method: "PATCH", pattern: /^\/docs\/(\d+)$/, kind: "act", op: "Update" },
    { method: "DELETE", pattern: /^\/docs\/(\d+)$/, kind: "act", op: "Delete" },
    { method: "POST", pattern: /^\/docs\/(\d+)\/publish$/, kind: "act", op: "Publish" },
    { method: "GET", pattern: /^\/audit$/, kind: "audit" }
  ];

  // apps/docs/src/http.ts
  var ROLES = ["Viewer", "Editor", "Admin"];
  function actorOf(h) {
    const id = Number(h["x-actor-id"]);
    const role = h["x-actor-role"];
    return Number.isSafeInteger(id) && id >= 0 && ROLES.includes(role) ? { id, role } : null;
  }
  function handle(engine, req) {
    for (const r of ROUTES) {
      const m = r.pattern.exec(req.path);
      if (r.method !== req.method || !m) continue;
      const actor2 = actorOf(req.headers);
      if (!actor2) return { status: 401, body: { error: "x-actor-id and x-actor-role headers are required" } };
      if (r.kind === "audit") return { status: 200, body: engine.auditLog() };
      const id = Number(m[1]);
      if (r.kind === "view") {
        const v = engine.view(actor2, id);
        return v ? { status: 200, body: v } : { status: 404, body: { error: "not found" } };
      }
      const b = req.body ?? {};
      const out = engine.act(actor2, id, r.op, r.op === "Update" ? { title: b.title, size: b.size } : {});
      switch (out.kind) {
        case "ok":
          return { status: 200, body: out.receipt };
        case "refused":
          return { status: STATUS_OF[out.reason], body: { error: out.reason } };
        case "not-found":
          return { status: 404, body: { error: "not found" } };
        case "bad-input":
          return { status: 400, body: { error: out.message } };
      }
    }
    return { status: 404, body: { error: "no such route" } };
  }

  // apps/docs/src/render.ts
  function renderView(v, a, doc = document) {
    const el = (tag, text, attrs = {}) => {
      const e = doc.createElement(tag);
      if (text !== void 0) e.textContent = text;
      for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
      return e;
    };
    const card = el("section", void 0, { "data-doc": String(v.id), class: "card" });
    card.append(el("h3", v.title, { "data-field": "title" }));
    card.append(el("span", v.status, { "data-field": "status", class: `badge ${v.status.toLowerCase()}` }));
    card.append(el("span", `${v.size} characters`, { "data-field": "size" }));
    const row = el("div", void 0, { class: "actions" });
    if (v["can-delete"]) {
      const b = el("button", "Delete", { "data-action": "delete" });
      b.addEventListener("click", () => a.remove());
      row.append(b);
    }
    if (v["can-publish"]) {
      const b = el("button", "Publish", { "data-action": "publish" });
      b.addEventListener("click", () => a.publish());
      row.append(b);
    }
    card.append(row);
    if (v["can-update"]) {
      const f = el("form", void 0, { "data-action": "update" });
      const t = el("input", void 0, { name: "title", value: v.title });
      const s = el("input", void 0, { name: "size", type: "number", value: String(v.size) });
      const b = el("button", "Save", { type: "submit" });
      f.append(t, s, b);
      f.addEventListener("submit", (e) => {
        e.preventDefault();
        a.update(t.value, Number(s.value));
      });
      card.append(f);
    }
    return card;
  }

  // apps/docs/src/browser.ts
  function local() {
    const store = new WebDocStore(localStorage);
    if (store.get(1) === null) seed(store);
    const engine = new DocsEngine(app_default, store, new WebAuditLog(localStorage));
    return { call: async (actor2, method, path, body) => handle(engine, { method, path, headers: { "x-actor-id": String(actor2.id), "x-actor-role": actor2.role }, body }) };
  }
  function remote() {
    return {
      call: async (actor2, method, path, body) => {
        const r = await fetch(path, { method, headers: { "x-actor-id": String(actor2.id), "x-actor-role": actor2.role, "content-type": "application/json" }, body: body ? JSON.stringify(body) : void 0 });
        return { status: r.status, body: await r.json() };
      }
    };
  }
  var backend = new URLSearchParams(location.search).get("backend") === "remote" ? remote() : local();
  var $ = (id) => document.getElementById(id);
  var actor = () => ({ id: Number($("actor-id").value), role: $("actor-role").value });
  var inflight = 0;
  var generation = 0;
  function refresh(message) {
    document.body.dataset.busy = String(++inflight);
    return refreshNow(message).finally(() => document.body.dataset.busy = String(--inflight));
  }
  async function refreshNow(message) {
    const mine = ++generation;
    shownActor = JSON.stringify(actor());
    const list = document.createDocumentFragment();
    for (const id of [1, 2, 3]) {
      const r = await backend.call(actor(), "GET", `/docs/${id}`);
      if (r.status !== 200) continue;
      const act = async (method, path, body) => {
        const res = await backend.call(actor(), method, path, body);
        await refresh(res.status === 200 ? `ok (${res.status})` : `refused: ${res.body.error} (${res.status})`);
      };
      list.append(renderView(r.body, { update: (title, size) => void act("PATCH", `/docs/${id}`, { title, size }), remove: () => void act("DELETE", `/docs/${id}`), publish: () => void act("POST", `/docs/${id}/publish`) }));
    }
    const a = await backend.call(actor(), "GET", "/audit");
    if (mine !== generation) return;
    $("docs").replaceChildren(list);
    $("message").textContent = message ?? "";
    $("audit").textContent = JSON.stringify(a.body);
  }
  var shownActor = "";
  for (const id of ["actor-id", "actor-role"]) $(id).addEventListener("change", () => {
    if (JSON.stringify(actor()) !== shownActor) void refresh();
  });
  $("backend").textContent = new URLSearchParams(location.search).get("backend") === "remote" ? "remote (Node server, SQLite)" : "local (in-page, localStorage)";
  void refresh();
})();
