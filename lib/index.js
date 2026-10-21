import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
//#region node_modules/@deepseek-ai/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Shared config references used by schema validators and plugin runtimes. */
const write = Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
	if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
	} finally {
		ancestors.delete(value);
	}
}
/**
* Create a detached reference containing an immutable copy of the supplied data.
* @param value - validated config data; class instances and functions are unsupported.
* @returns a reference whose value is updated only by its owning runtime.
*/
function createVolatile(value) {
	let current = snapshot(value);
	return Object.freeze({
		get: () => current,
		[write]: (value) => {
			current = value;
		}
	});
}
/**
* Identify references across ESM/CJS copies of the shared library.
* @param value - a parsed config value.
* @returns whether the value implements the shared reference protocol.
*/
function isVolatile(value) {
	return typeof value === "object" && value !== null && write in value;
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary) {
	Binary.is = isArrayBufferLike;
	Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/**
* Compare values recursively, treating two volatile references as equal regardless of value.
* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
* @param a - first value.
* @param b - second value.
* @param strict - whether to require strict data equality outside volatile references.
* @returns whether the values compare equal.
*/
function deepEqual(a, b, strict) {
	const ancestors = /* @__PURE__ */ new Set();
	function compare(a, b) {
		if (a === b) return true;
		if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b);
		if (!strict && isNullable(a) && isNullable(b)) return true;
		if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
		if (ancestors.has(a)) return false;
		function check(test, then) {
			return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
		}
		ancestors.add(a);
		try {
			return check(Array.isArray, (a, b) => {
				if (a.length !== b.length) return false;
				for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
				return true;
			}) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("URL"), (a, b) => a.href === b.href) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
				...a,
				...b
			}).every((key) => compare(a[key], b[key])));
		} finally {
			ancestors.delete(a);
		}
	}
	return compare(a, b);
}
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region node_modules/@deepseek-ai/schemastery/lib/index.mjs
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (isVolatile(value)) value = value.get();
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.volatile = function volatile() {
	if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
	return this.extra("volatile", true);
};
const resolvers = {};
const checkedVolatile = Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
	const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
	if (states.has(blocked)) return;
	states.add(blocked);
	seen.set(schema, states);
	if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
	const nested = blocked || !!schema.meta?.volatile;
	if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
	if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
	if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
	if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (!options[checkedVolatile]) {
		validateVolatileSchema(schema, options.path);
		options = {
			...options,
			[checkedVolatile]: true
		};
	}
	if (schema.meta?.volatile) {
		const inner = Schema(schema);
		inner.meta = {
			...schema.meta,
			volatile: false
		};
		const [value, adapted] = Schema.resolve(data, inner, options, strict);
		try {
			return [createVolatile(value), adapted];
		} catch (error) {
			throw new ValidationError(error instanceof Error ? error.message : String(error), options);
		}
	}
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
		validateVolatileSchema(schema.inner, options.path, true);
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region src/config.ts
/**
* The plugin's Cordis `Config` and the plain snapshot the adapter reads.
*
* Every user-editable field is `.volatile()`: the settings service projects it
* into the browser form and hands this plugin a reference whose `.get()` is the
* current value, so a settings write reaches the next request without a reload.
* The plain snapshot below also accepts ordinary values, which keeps the module
* usable from tests and from a hand-written `cordis.patch.yml`.
*/
/** Provider route this bundle registers; also the model picker's group id. */
const DEFAULT_PROVIDER = "google-cloud";
/** Provider label shown by model selectors and the Models page row. */
const DEFAULT_DISPLAY_NAME = "Google Cloud";
/** Credential reference the provider card derives from the route id. */
const DEFAULT_API_KEY_REF = "GOOGLE_CLOUD_API_KEY";
/** Gemini 4 Argon is published only in the global location. */
const DEFAULT_LOCATION = "global";
/** Capacity fallbacks for a model the catalog does not describe. */
const DEFAULT_CONTEXT_WINDOW = 1048576;
const DEFAULT_MAX_TOKENS = 65536;
/** Longest wait for the next server-sent event before a call fails with TIMEOUT. */
const DEFAULT_IDLE_TIMEOUT_MS = 3e5;
/** Models offered until the profile declares its own catalog. */
const MODEL_DEFAULTS = [
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		contextWindow: 1048576,
		maxTokens: 1048576
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-3.5-flash-lite",
		name: "Gemini 3.5 Flash-Lite",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro (Preview)",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-3.1-flash-lite",
		name: "Gemini 3.1 Flash-Lite",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash (Preview)",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-2.5-flash-lite",
		name: "Gemini 2.5 Flash-Lite",
		contextWindow: 1048576,
		maxTokens: 65536
	}
];
/** Rewrite legacy hyphenated minor-version ids (e.g. `gemini-3-5-flash` → `gemini-3.5-flash`). */
function canonicalModelId(id) {
	return id.trim().replace(/^(gemini-[23])-([1-9])(?=-)/i, "$1.$2");
}
const ModelSchema = Schema.object({
	id: Schema.string().required().description("Publisher model id sent to Vertex AI."),
	name: Schema.string().description("Display name shown by model selectors."),
	description: Schema.string().description("Optional one-line description kept for editing surfaces."),
	contextWindow: Schema.number().step(1).min(1).description("Context window in tokens."),
	maxTokens: Schema.number().step(1).min(1).description("Default output token cap."),
	input: Schema.array(Schema.string()).description("Input modalities a generic provider editor may write; this route is text-only."),
	inputModalities: Schema.array(Schema.string()).description("Input modalities a generic provider editor may write; this route is text-only.")
}).description("One model published by this route.");
const Config = Schema.object({
	provider: Schema.string().default(DEFAULT_PROVIDER).description("Provider route name every request selects with GenerateOptions.provider.").volatile(),
	displayName: Schema.string().default(DEFAULT_DISPLAY_NAME).description("Provider label shown by model selectors.").volatile(),
	projectId: Schema.string().default("").description("Google Cloud project id or project number used in the Vertex AI request path.").volatile(),
	location: Schema.string().default(DEFAULT_LOCATION).description("Location the published model is served from. Gemini 4 Argon is global-only.").volatile(),
	baseURL: Schema.string().default("").description("Optional endpoint override; empty derives the host from the location.").volatile(),
	proxy: Schema.string().default("").description("Proxy URL: http://, https://, socks5:// or socks5h://; empty connects directly, \"auto\" reads the environment.").volatile(),
	apiKeyEnv: Schema.string().role("credential-ref").default(DEFAULT_API_KEY_REF).description("Credential reference for the Express-mode API key.").volatile(),
	models: Schema.array(ModelSchema).default([...MODEL_DEFAULTS]).description("Model catalog this route advertises.").volatile(),
	streamIdleTimeoutMs: Schema.number().step(1).min(1).default(DEFAULT_IDLE_TIMEOUT_MS).description("Longest wait without a server-sent event before the call fails with TIMEOUT.").volatile()
});
/** Read one field, which may be a reference object. */
function readField(field, fallback) {
	if (field === void 0 || field === null) return fallback;
	if (typeof field.get === "function") {
		const value = field.get();
		return value === void 0 || value === null ? fallback : value;
	}
	return field;
}
/** Keep only well-formed catalog rows so one bad row cannot break the route. */
function normalizeModels(models) {
	const rows = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of models ?? []) {
		const id = typeof entry.id === "string" ? canonicalModelId(entry.id) : "";
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		const contextWindow = Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : DEFAULT_CONTEXT_WINDOW;
		const maxTokens = Number.isSafeInteger(entry.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : DEFAULT_MAX_TOKENS;
		rows.push({
			id,
			name: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id,
			contextWindow,
			maxTokens
		});
	}
	return rows.length > 0 ? rows : MODEL_DEFAULTS.map((model) => ({ ...model }));
}
/** Snapshot the raw configuration into the values the adapter reads. */
function readConfig(config) {
	const source = config ?? {};
	return {
		provider: String(readField(source.provider, "google-cloud")).trim() || "google-cloud",
		displayName: String(readField(source.displayName, "Google Cloud")).trim() || "Google Cloud",
		projectId: String(readField(source.projectId, "")).trim(),
		location: String(readField(source.location, "global")).trim() || "global",
		baseURL: String(readField(source.baseURL, "")).trim(),
		proxy: String(readField(source.proxy, "")).trim(),
		apiKeyEnv: String(readField(source.apiKeyEnv, "GOOGLE_CLOUD_API_KEY")).trim() || "GOOGLE_CLOUD_API_KEY",
		models: normalizeModels(readField(source.models, MODEL_DEFAULTS)),
		streamIdleTimeoutMs: Number(readField(source.streamIdleTimeoutMs, 3e5)) || 3e5
	};
}
/** The endpoint base for one location; an explicit override wins. */
function endpointOf(baseURL, location) {
	const override = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
	if (override !== "") return override;
	if (location === "global") return "https://aiplatform.googleapis.com";
	if (location === "us" || location === "eu") return `https://aiplatform.${location}.rep.googleapis.com`;
	return `https://${location}-aiplatform.googleapis.com`;
}
//#endregion
//#region src/errors.ts
/**
* Failure construction for the Google Cloud adapter.
*
* The `llm` service classifies adapter failures by the own `code` and
* `failure` data properties its normalizer reads, not by `instanceof`: a plain
* `Error` carrying both keeps its retry classification even though this bundle
* ships its own object graph.
*/
/** Code for a credential the transport cannot send. */
const INVALID_CREDENTIAL = "INVALID_CREDENTIAL";
/** Characters an HTTP header value carries verbatim and every provider key uses. */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/;
/** Build one classified failure. */
function llmError(message, code, extra) {
	const error = new Error(message);
	error.name = "LlmError";
	error.code = code;
	error.failure = Object.freeze({
		message,
		code,
		...extra ?? {}
	});
	return error;
}
/** Accept one supplied key, or refuse it before the socket layer sees it. */
function assertUsableKey(raw, module, ref) {
	const value = String(raw).trim();
	if (value === "") throw llmError(`${module}: the API key resolved from ${ref} is blank; save it again in the Models provider card`, INVALID_CREDENTIAL);
	if (!LEGAL_API_KEY.test(value)) throw llmError(`${module}: the API key resolved from ${ref} contains characters no HTTP header can carry; store the raw key alone`, INVALID_CREDENTIAL);
	return value;
}
//#endregion
//#region src/transport.ts
/**
* HTTP(S) transport with optional proxy tunneling.
*
* The harness Host is a Node process, and Node's global `fetch` does not route
* through a proxy on its own, so this module owns the connection: direct or
* through an `http://`, `https://`, or `socks5(h)://` proxy, then a plain
* HTTP/1.1 exchange over the resulting socket. Speaking HTTP directly keeps
* the streamed response a Node readable, which is what the SSE reader wants.
*/
/** Longest a socket connect or a proxy handshake may take. */
const CONNECT_TIMEOUT_MS = 2e4;
/** Longest CONNECT response head this module buffers. */
const MAX_PROXY_HEAD_BYTES = 16384;
/** Split an endpoint URL into connection facts and the request path. */
function parseEndpoint(endpoint) {
	const url = new URL(endpoint);
	const scheme = url.protocol === "http:" ? "http" : "https";
	return {
		scheme,
		host: url.hostname,
		port: Number(url.port) || (scheme === "https" ? 443 : 80),
		prefix: url.pathname.replace(/\/+$/, ""),
		pathWithQuery: `${url.pathname}${url.search}`
	};
}
/** First non-empty value among some environment variables. */
function envValue(names) {
	for (const name of names) {
		const value = process.env[name];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
}
/** Whether NO_PROXY excludes this host from the ambient proxy. */
function bypassesProxy(host) {
	const raw = envValue(["NO_PROXY", "no_proxy"]);
	if (raw === void 0) return false;
	const target = host.toLowerCase();
	return raw.split(",").map((item) => item.trim().toLowerCase()).some((item) => {
		if (item === "") return false;
		if (item === "*") return true;
		const bare = item.replace(/^\./, "");
		return target === bare || target.endsWith(`.${bare}`);
	});
}
/** Resolve the configured proxy for one target host, or undefined for a direct connection. */
function parseProxy(raw, targetHost, module) {
	let text = String(raw ?? "").trim();
	if (text === "" || text === "direct" || text === "none") return void 0;
	if (text === "auto") {
		text = envValue([
			"HTTPS_PROXY",
			"https_proxy",
			"ALL_PROXY",
			"all_proxy",
			"HTTP_PROXY",
			"http_proxy"
		]) ?? "";
		if (text === "") return void 0;
		if (bypassesProxy(targetHost)) return void 0;
	}
	let url;
	try {
		url = new URL(text);
	} catch {
		throw llmError(`${module}: the proxy setting "${text}" is not a URL`, "INVALID_CONFIG");
	}
	const protocol = url.protocol.toLowerCase();
	const kind = protocol === "socks5:" || protocol === "socks5h:" || protocol === "socks:" ? "socks5" : protocol === "https:" ? "https" : protocol === "http:" ? "http" : void 0;
	if (kind === void 0) throw llmError(`${module}: unsupported proxy scheme "${protocol}"; use http, https, socks5 or socks5h`, "INVALID_CONFIG");
	const auth = url.username === "" && url.password === "" ? void 0 : {
		username: decodeURIComponent(url.username),
		password: decodeURIComponent(url.password)
	};
	return {
		kind,
		host: url.hostname,
		port: Number(url.port) || (kind === "https" ? 443 : kind === "http" ? 80 : 1080),
		auth
	};
}
/** Buffered exact-length reads over one socket, used by the proxy handshakes. */
var SocketReader = class {
	socket;
	buffer = Buffer.alloc(0);
	waiter;
	failure;
	constructor(socket) {
		this.socket = socket;
		socket.on("data", this.onData);
		socket.on("error", this.onError);
		socket.on("close", this.onClose);
	}
	onData = (chunk) => {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		this.flush();
	};
	onError = (error) => {
		this.failure = error;
		this.flush();
	};
	onClose = () => {
		if (this.failure === void 0) this.failure = /* @__PURE__ */ new Error("the proxy closed the connection");
		this.flush();
	};
	read(length) {
		return new Promise((resolve, reject) => {
			this.waiter = {
				length,
				resolve,
				reject
			};
			this.flush();
		});
	}
	flush() {
		const waiter = this.waiter;
		if (waiter === void 0) return;
		if (this.failure !== void 0) {
			this.waiter = void 0;
			waiter.reject(this.failure);
			return;
		}
		if (this.buffer.length < waiter.length) return;
		this.waiter = void 0;
		const out = this.buffer.subarray(0, waiter.length);
		this.buffer = this.buffer.subarray(waiter.length);
		waiter.resolve(out);
	}
	/** Stop reading and hand bytes that belong to the next protocol layer back to the socket. */
	release() {
		this.socket.removeListener("data", this.onData);
		this.socket.removeListener("error", this.onError);
		this.socket.removeListener("close", this.onClose);
		const rest = this.buffer;
		this.buffer = Buffer.alloc(0);
		if (rest.length > 0) this.socket.unshift(rest);
	}
	/** Drop the reader without handing buffered bytes back (a failed handshake). */
	fail() {
		this.socket.removeListener("data", this.onData);
		this.socket.removeListener("error", this.onError);
		this.socket.removeListener("close", this.onClose);
	}
};
/** Open one TCP connection, honouring a cancellation signal and the connect timeout. */
function connectSocket(host, port, signal) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({
			host,
			port
		});
		let settled = false;
		const onError = (error) => fail(error);
		const onAbort = () => fail(/* @__PURE__ */ new Error("aborted"));
		const cleanup = () => {
			socket.setTimeout(0);
			socket.removeListener("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			reject(error);
		};
		socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(/* @__PURE__ */ new Error(`connecting to ${host}:${port} timed out`)));
		socket.once("error", onError);
		if (signal !== void 0) {
			if (signal.aborted) {
				fail(/* @__PURE__ */ new Error("aborted"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		socket.once("connect", () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		});
	});
}
/** Wrap one connected socket in TLS for the named server. */
function secureSocket(socket, host) {
	return new Promise((resolve, reject) => {
		const secured = tls.connect({
			socket,
			servername: host,
			ALPNProtocols: ["http/1.1"]
		});
		const onError = (error) => reject(error);
		secured.once("error", onError);
		secured.once("secureConnect", () => {
			secured.removeListener("error", onError);
			resolve(secured);
		});
	});
}
/** Establish an HTTP CONNECT tunnel through an http:// or https:// proxy. */
async function httpConnect(socket, target, auth) {
	const authority = `${target.host}:${target.port}`;
	const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
	if (auth !== void 0) lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`);
	socket.write(`${lines.join("\r\n")}\r\n\r\n`);
	const reader = new SocketReader(socket);
	let head = "";
	try {
		while (!head.includes("\r\n\r\n")) {
			head += (await reader.read(1)).toString("latin1");
			if (head.length > MAX_PROXY_HEAD_BYTES) throw new Error("the proxy did not answer CONNECT");
		}
		reader.release();
	} catch (error) {
		reader.fail();
		throw error;
	}
	const statusLine = head.split("\r\n")[0] ?? "";
	if (Number(statusLine.split(" ")[1]) !== 200) throw new Error(`the proxy refused CONNECT (${statusLine})`);
}
/** Establish a SOCKS5 (RFC 1928) tunnel, optionally with username/password authentication. */
async function socks5Connect(socket, target, auth) {
	const reader = new SocketReader(socket);
	try {
		socket.write(auth === void 0 ? Buffer.from([
			5,
			1,
			0
		]) : Buffer.from([
			5,
			2,
			0,
			2
		]));
		const greeting = await reader.read(2);
		if (greeting[0] !== 5) throw new Error("the SOCKS5 proxy answered with an unknown version");
		if (greeting[1] === 2) {
			if (auth === void 0) throw new Error("the SOCKS5 proxy requires a username and password");
			const user = Buffer.from(auth.username, "utf8");
			const password = Buffer.from(auth.password, "utf8");
			socket.write(Buffer.concat([
				Buffer.from([1, user.length]),
				user,
				Buffer.from([password.length]),
				password
			]));
			if ((await reader.read(2))[1] !== 0) throw new Error("the SOCKS5 proxy rejected the username and password");
		} else if (greeting[1] !== 0) throw new Error(`the SOCKS5 proxy selected an unsupported authentication method (${greeting[1]})`);
		const host = Buffer.from(target.host, "utf8");
		const port = Buffer.from([Math.floor(target.port / 256) & 255, target.port & 255]);
		socket.write(Buffer.concat([
			Buffer.from([
				5,
				1,
				0,
				3,
				host.length
			]),
			host,
			port
		]));
		const reply = await reader.read(4);
		if (reply[0] !== 5) throw new Error("the SOCKS5 proxy answered with an unknown version");
		if (reply[1] !== 0) throw new Error(`the SOCKS5 proxy refused the connection (code ${reply[1]})`);
		if (reply[3] === 1) await reader.read(6);
		else if (reply[3] === 4) await reader.read(18);
		else if (reply[3] === 3) await reader.read((await reader.read(1))[0] + 2);
		else throw new Error("the SOCKS5 proxy answered with an unknown address type");
		reader.release();
	} catch (error) {
		reader.fail();
		throw error;
	}
}
/** One connected, TLS-ready socket for one endpoint, directly or through the configured proxy. */
async function openTunnel(endpoint, proxySetting, module, signal) {
	const proxy = parseProxy(proxySetting, endpoint.host, module);
	const wrap = async (socket) => endpoint.scheme === "https" ? secureSocket(socket, endpoint.host) : socket;
	if (proxy === void 0) return wrap(await connectSocket(endpoint.host, endpoint.port, signal));
	const socket = await connectSocket(proxy.host, proxy.port, signal);
	try {
		const tunnelled = proxy.kind === "https" ? await secureSocket(socket, proxy.host) : socket;
		if (proxy.kind === "socks5") await socks5Connect(tunnelled, endpoint, proxy.auth);
		else await httpConnect(tunnelled, endpoint, proxy.auth);
		return await wrap(tunnelled);
	} catch (error) {
		socket.destroy();
		throw llmError(`${module}: the ${proxy.kind} proxy ${proxy.host}:${proxy.port} failed: ${error instanceof Error ? error.message : String(error)}`, "TRANSPORT");
	}
}
/** An HTTP agent that always hands back the one socket already tunneled. */
var SocketAgent = class extends http.Agent {
	socket;
	constructor(socket) {
		super({ keepAlive: false });
		this.socket = socket;
	}
	createConnection() {
		return this.socket;
	}
};
/** Send one request over the (optionally proxied) connection and resolve with its response head. */
async function performRequest(endpoint, proxySetting, module, init, signal) {
	const socket = await openTunnel(endpoint, proxySetting, module, signal);
	return new Promise((resolve, reject) => {
		const outgoing = http.request({
			host: endpoint.host,
			port: endpoint.port,
			method: init.method,
			path: init.path,
			headers: {
				host: endpoint.host,
				connection: "close",
				...init.headers
			},
			agent: new SocketAgent(socket)
		}, (response) => {
			resolve({
				status: response.statusCode ?? 0,
				stream: response
			});
		});
		const onAbort = () => {
			outgoing.destroy(/* @__PURE__ */ new Error("aborted"));
		};
		if (signal !== void 0) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const detach = () => {
			signal?.removeEventListener("abort", onAbort);
		};
		outgoing.on("error", (error) => {
			detach();
			reject(error);
		});
		outgoing.on("close", detach);
		if (init.body !== void 0) outgoing.write(init.body);
		outgoing.end();
	});
}
/** Read a bounded response body as text. */
async function readAll(stream, limit) {
	let text = "";
	for await (const chunk of stream) {
		text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		if (text.length > limit) {
			stream.destroy();
			break;
		}
	}
	return text;
}
//#endregion
//#region src/catalog.ts
/** How long one discovery answer stands. */
const DISCOVERY_TTL_MS = 6e5;
/** Longest one discovery call may take before the configured list applies. */
const DISCOVERY_TIMEOUT_MS = 6e3;
/** Largest listing body this module parses. */
const DISCOVERY_BODY_LIMIT = 4194304;
/** Model families published by `publishers/google` that cannot serve a chat call. */
const NON_CHAT_MODEL = /(?:^gemini-(?:omni|live|embedding|nano-banana)(?:-|$)|-(?:image|tts|live|transcribe|translate|embedding|robotics|vision|custom|omni|audio)(?:-|$))/i;
/** Publisher-model listing endpoints, most specific first. */
function publisherModelUrls(settings) {
	const base = endpointOf(settings.baseURL, settings.location);
	const path = `projects/${encodeURIComponent(settings.projectId)}/locations/${encodeURIComponent(settings.location)}/publishers/google/models?pageSize=200`;
	return [`${base}/v1/${path}`, `${base}/v1beta1/${path}`];
}
/** Turn one publisher-model resource into a catalog entry, or reject it. */
function discoveredModel(row, configured) {
	if (row === null || typeof row !== "object") return void 0;
	const record = row;
	const name = typeof record.name === "string" ? record.name : "";
	const marker = name.lastIndexOf("/models/");
	const id = marker === -1 ? "" : canonicalModelId(name.slice(marker + 8));
	if (id === "" || !/^gemini-/i.test(id)) return void 0;
	if (NON_CHAT_MODEL.test(id)) return void 0;
	const actions = Array.isArray(record.supportedActions) ? record.supportedActions : void 0;
	if (actions !== void 0 && actions.length > 0 && !actions.includes("generateContent")) return void 0;
	const known = configured.find((model) => model.id === id);
	if (known !== void 0) return { ...known };
	return {
		id,
		name: typeof record.displayName === "string" && record.displayName.trim() !== "" ? record.displayName.trim() : id,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS
	};
}
/** Discovery plus exact-model lookup over the configured catalog. */
var ModelCatalog = class {
	read;
	resolveKey;
	module;
	cache = /* @__PURE__ */ new Map();
	pending;
	/**
	* @param read - current provider settings.
	* @param resolveKey - credential lookup; a rejection is a discovery diagnostic, not a failure.
	* @param module - package name prefixed to failures.
	*/
	constructor(read, resolveKey, module) {
		this.read = read;
		this.resolveKey = resolveKey;
		this.module = module;
	}
	/** The catalog the profile declares. */
	configured() {
		return this.read().models;
	}
	/** Resolve one exact model id against the configured and discovered catalogs. */
	known(id) {
		const target = canonicalModelId(id);
		const configured = this.configured().find((model) => model.id === target);
		if (configured !== void 0) return configured;
		for (const answer of this.cache.values()) {
			const hit = answer.models.find((model) => model.id === target);
			if (hit !== void 0) return hit;
		}
	}
	/** The model list this route advertises right now. */
	async list() {
		const settings = this.read();
		if (settings.projectId === "") return settings.models;
		const key = `${settings.projectId}|${settings.location}|${settings.baseURL}|${settings.proxy}|${settings.models.map((model) => model.id).join(",")}`;
		const cached = this.cache.get(key);
		if (cached !== void 0 && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.models;
		if (this.pending?.key === key) return (await this.pending.run).models;
		const run = this.discover(settings, key);
		this.pending = {
			key,
			run
		};
		try {
			return (await run).models;
		} finally {
			if (this.pending?.run === run) this.pending = void 0;
		}
	}
	/** Ask the endpoint for its publisher models, falling back to the profile. */
	async discover(settings, key) {
		let apiKey;
		try {
			apiKey = await this.resolveKey();
		} catch {
			return this.fallback(settings, key, "missing credential");
		}
		if (apiKey === void 0) return this.fallback(settings, key, "missing credential");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
		timer.unref?.();
		let failure = "unreachable";
		try {
			for (const url of publisherModelUrls(settings)) {
				const endpoint = parseEndpoint(url);
				let response;
				try {
					response = await performRequest(endpoint, settings.proxy, this.module, {
						method: "GET",
						path: endpoint.pathWithQuery,
						headers: {
							accept: "application/json",
							"x-goog-api-key": apiKey
						}
					}, controller.signal);
				} catch {
					failure = "unreachable";
					continue;
				}
				if (response.status < 200 || response.status >= 300) {
					response.stream.destroy();
					failure = `HTTP ${response.status}`;
					continue;
				}
				let payload;
				try {
					payload = JSON.parse(await readAll(response.stream, DISCOVERY_BODY_LIMIT));
				} catch {
					payload = void 0;
				}
				const record = payload !== null && typeof payload === "object" ? payload : void 0;
				const rows = Array.isArray(record?.publisherModels) ? record.publisherModels : Array.isArray(record?.models) ? record.models : void 0;
				if (rows === void 0) {
					failure = "unexpected payload";
					continue;
				}
				const discovered = [];
				const seen = /* @__PURE__ */ new Set();
				for (const row of rows) {
					const model = discoveredModel(row, settings.models);
					if (model === void 0 || seen.has(model.id)) continue;
					seen.add(model.id);
					discovered.push(model);
				}
				if (discovered.length === 0) {
					failure = "no chat models listed";
					continue;
				}
				const answer = {
					models: [...discovered, ...settings.models.filter((model) => !seen.has(model.id))],
					source: "api",
					at: Date.now()
				};
				this.cache.set(key, answer);
				return answer;
			}
			return this.fallback(settings, key, failure);
		} finally {
			clearTimeout(timer);
		}
	}
	/** Cache and return the configured catalog with its discovery diagnostic. */
	fallback(settings, key, diagnostic) {
		const answer = {
			models: settings.models,
			source: "config",
			diagnostic,
			at: Date.now()
		};
		this.cache.set(key, answer);
		return answer;
	}
};
//#endregion
//#region src/projection.ts
/** Provider schema keys Vertex AI refuses inside function declarations. */
const UNSUPPORTED_SCHEMA_KEYS = /* @__PURE__ */ new Set([
	"$schema",
	"$id",
	"$ref",
	"$defs",
	"$comment",
	"additionalProperties",
	"patternProperties",
	"unevaluatedProperties",
	"dependentSchemas",
	"examples",
	"default",
	"oneOf"
]);
/** Rewrite one JSON schema into the OpenAPI subset Vertex AI accepts. */
function sanitizeSchema(node) {
	if (Array.isArray(node)) return node.map(sanitizeSchema);
	if (node === null || typeof node !== "object") return node;
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
		if (key === "const") {
			out.enum = [value];
			continue;
		}
		if (key === "type" && Array.isArray(value)) {
			const types = value.filter((item) => typeof item === "string");
			const primary = types.find((item) => item !== "null");
			if (primary !== void 0) out.type = primary;
			if (types.includes("null")) out.nullable = true;
			continue;
		}
		out[key] = sanitizeSchema(value);
	}
	return out;
}
/** Build the `tools` array for one request, or undefined when no tool is active. */
function buildTools(tools) {
	if (tools === void 0 || tools.length === 0) return void 0;
	const declarations = [];
	for (const tool of tools) {
		if (typeof tool.name !== "string" || tool.name === "") continue;
		const parameters = tool.parameters !== null && typeof tool.parameters === "object" ? sanitizeSchema(tool.parameters) : {
			type: "object",
			properties: {}
		};
		declarations.push({
			name: tool.name,
			description: typeof tool.description === "string" ? tool.description : "",
			parameters: {
				...parameters,
				type: "object"
			}
		});
	}
	return declarations.length > 0 ? [{ functionDeclarations: declarations }] : void 0;
}
/** Collect the visible text of one content block list. */
function textOf(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const record = block;
		if ((record.type === "text" || record.type === "reasoning") && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("");
}
/** Largest tool result this adapter sends back in one part. */
const MAX_FUNCTION_RESPONSE_CHARS = 524288;
/**
* Project one tool result for a `functionResponse` part.
*
* Gemini reads a `$ref` member inside `functionResponse.response` as a
* reference to a named response part, so a tool that returns a JSON Schema
* (any `$defs`/`$ref` document) would fail the whole turn with
* `The referenced name "#/$defs/…" … does not match to a display_name`. The
* result therefore travels as one text value, and a bare JSON pointer is
* escaped so it cannot be read as a reference either.
*/
function functionResponseResult(text) {
	const body = text.length > MAX_FUNCTION_RESPONSE_CHARS ? `${text.slice(0, MAX_FUNCTION_RESPONSE_CHARS)}\n…[truncated]` : text;
	return body.startsWith("#/") ? ` ${body}` : body;
}
/** Accept the replay envelope this adapter wrote, for the same provider and model. */
function replayParts(replayState, model) {
	if (replayState === null || typeof replayState !== "object") return void 0;
	const response = replayState.response;
	if (response === null || typeof response !== "object") return void 0;
	const envelope = response;
	if (envelope.v !== 1 || typeof envelope.model !== "string" || canonicalModelId(envelope.model) !== canonicalModelId(model)) return;
	if (!Array.isArray(envelope.parts) || envelope.parts.length === 0) return void 0;
	return envelope.parts;
}
/** One request's message projection, built once per stream. */
function projectMessages(options, model) {
	const contents = [];
	const systemTexts = [];
	const toolNames = /* @__PURE__ */ new Map();
	const degraded = /* @__PURE__ */ new Set();
	/**
	* Order the parts of one user turn the way Vertex parses them.
	*
	* Vertex mis-reads a turn whose `functionResponse` parts are followed by
	* plain text: it loses the turn boundary and refuses the whole request with
	* "Requests ending with a model turn are not supported", even though the
	* request ends with a user turn. Text first, then the responses, is
	* accepted. Relative order inside each group is kept, so parallel responses
	* still line up with the calls of the turn above.
	*/
	const orderUserParts = (parts) => {
		let responses = 0;
		for (const part of parts) if (part.functionResponse !== void 0) responses += 1;
		if (responses === 0 || responses === parts.length) return parts;
		const lead = [];
		const tail = [];
		for (const part of parts) if (part.functionResponse === void 0) lead.push(part);
		else tail.push(part);
		return [...lead, ...tail];
	};
	const push = (role, parts) => {
		if (parts.length === 0) return;
		const ordered = role === "user" ? orderUserParts(parts) : parts;
		const last = contents[contents.length - 1];
		if (last !== void 0 && last.role === role) {
			last.parts.push(...ordered);
			if (role === "user") last.parts = orderUserParts(last.parts);
			return;
		}
		contents.push({
			role,
			parts: ordered
		});
	};
	for (const message of options.messages) {
		const record = message;
		if (record === null || typeof record !== "object") continue;
		const content = Array.isArray(record.content) ? record.content : [];
		switch (record.role) {
			case "system":
			case "developer": {
				const text = textOf(content);
				if (text.trim() !== "") systemTexts.push(text);
				break;
			}
			case "user": {
				const parts = [];
				for (const block of content) {
					if (block === null || typeof block !== "object") continue;
					const item = block;
					if (item.type === "text" && typeof item.text === "string" && item.text !== "") parts.push({ text: item.text });
					else if (item.type === "image") parts.push({ text: "[image attachment omitted by this route]" });
					else if (item.type === "file" && item.attachment !== void 0) parts.push({ text: `[file ${String(item.attachment.name)}]` });
				}
				push("user", parts);
				break;
			}
			case "assistant": {
				for (const block of content) {
					if (block === null || typeof block !== "object") continue;
					const item = block;
					if (item.type === "tool-call" && typeof item.id === "string" && typeof item.name === "string") toolNames.set(item.id, item.name);
				}
				const restored = replayParts(record.source?.replayState, model);
				if (restored !== void 0) {
					push("model", restored.map((part) => ({ ...part })));
					break;
				}
				const parts = [];
				for (const block of content) {
					if (block === null || typeof block !== "object") continue;
					const item = block;
					if (item.type === "text" && typeof item.text === "string" && item.text !== "") parts.push({ text: item.text });
					else if (item.type === "tool-call" && typeof item.id === "string") {
						degraded.add(item.id);
						const args = typeof item.arguments === "string" && item.arguments !== "" ? item.arguments : "{}";
						parts.push({ text: `[Tool call ${String(item.name)}(${args})]` });
					}
				}
				push("model", parts);
				break;
			}
			case "tool": {
				const id = typeof record.toolCallId === "string" ? record.toolCallId : "";
				const name = toolNames.get(id);
				const text = textOf(content);
				if (degraded.has(id) || name === void 0) push("user", [{ text: `[Tool result${name === void 0 ? "" : ` ${name}`}] ${text}` }]);
				else push("user", [{ functionResponse: {
					name,
					response: { result: functionResponseResult(text) }
				} }]);
				break;
			}
		}
	}
	const systemText = [options.system, ...systemTexts].filter((item) => typeof item === "string" && item.trim() !== "").join("\n\n");
	return {
		contents,
		...systemText === "" ? {} : { systemInstruction: { parts: [{ text: systemText }] } }
	};
}
//#endregion
//#region src/adapter.ts
/** Where the shape of the last rejected request is written, for diagnosis. */
const REJECTION_REPORT = join(tmpdir(), "dsh-google-cloud-rejection.json");
/**
* Record the shape (roles and part kinds, never text) of the request Vertex
* refused, so a 400 can be explained from the log without another attempt.
*/
function recordRejectedRequest(report) {
	try {
		writeFileSync(REJECTION_REPORT, JSON.stringify({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			...report
		}, null, 2));
	} catch {}
}
/** Name prefixed to every diagnostic this module raises. */
const MODULE = "llm-google-cloud";
/** Every selectable thinking level, least to greatest. */
const REASONING_EFFORTS = [
	{
		id: "off",
		name: "Off",
		description: "Lowest server-side thinking level, without thought summaries."
	},
	{
		id: "low",
		name: "Low",
		description: "Short thinking with a thought summary."
	},
	{
		id: "medium",
		name: "Medium",
		description: "Balanced thinking with a thought summary."
	},
	{
		id: "high",
		name: "High",
		description: "Deep thinking with a thought summary."
	}
];
/** Brand one effort id for the service vocabulary. */
const effortOf = (id) => id;
/** Gemini 2.5 models take a token budget; later models take a named level. */
function usesThinkingBudget(model) {
	return /^gemini-2[.-]5/i.test(model);
}
/** Gemini 3.0–3.6 Flash/Flash-Lite models accept MINIMAL as their lowest thinking level. */
function supportsMinimalThinkingLevel(model) {
	return /^gemini-3(?:|-0|\.[156])-flash/i.test(model);
}
/** Translate one effort id into the request's thinking configuration. */
function thinkingConfig(model, effort) {
	const includeThoughts = effort !== void 0 && effort !== "off";
	if (usesThinkingBudget(model)) {
		if (effort === void 0 || effort === "off") return {
			thinkingBudget: /^gemini-2[.-]5-pro/i.test(model) ? -1 : 0,
			includeThoughts: false
		};
		const maxBudget = /^gemini-2[.-]5-pro/i.test(model) ? 32768 : 24576;
		return {
			thinkingBudget: effort === "low" ? 1024 : effort === "medium" ? 8192 : maxBudget,
			includeThoughts
		};
	}
	const offLevel = supportsMinimalThinkingLevel(model) ? "MINIMAL" : "LOW";
	return {
		thinkingLevel: effort === "medium" ? "MEDIUM" : effort === "high" ? "HIGH" : effort === "low" ? "LOW" : offLevel,
		includeThoughts
	};
}
/** Map a provider HTTP status onto the harness failure vocabulary. */
function failureCode(status) {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 429) return "RATE_LIMIT";
	if (status >= 500) return "SERVER";
	return "INVALID_REQUEST";
}
/** Turn one provider error body into a short diagnostic. */
function providerErrorText(status, text) {
	if (text === "") return `HTTP ${status}`;
	try {
		const message = JSON.parse(text).error?.message;
		if (typeof message === "string" && message !== "") return message.length > 1200 ? `${message.slice(0, 1200)}…` : message;
	} catch {}
	return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}
/** The Gemini-on-Vertex adapter for this bundle's provider route. */
var GoogleCloudAdapter = class {
	host;
	read;
	catalog;
	/**
	* @param host - credential lookup owned by the plugin.
	* @param read - current provider settings, re-read on every request.
	*/
	constructor(host, read) {
		this.host = host;
		this.read = read;
		this.catalog = new ModelCatalog(read, () => this.host.resolveCredential(read().apiKeyEnv), MODULE);
	}
	/** @inheritdoc */
	providerInfo(provider) {
		return {
			id: provider,
			name: this.read().displayName
		};
	}
	/** @inheritdoc */
	providerRetryPolicy() {}
	/** @inheritdoc */
	imageRequestPricing() {}
	/** @inheritdoc */
	imageRequestTarget(_provider, _model, image) {
		return {
			width: image.width,
			height: image.height,
			maxBytes: image.bytes
		};
	}
	/** @inheritdoc */
	async listModels(provider) {
		return (await this.catalog.list()).map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			inputModalities: ["text"]
		}));
	}
	/** @inheritdoc */
	async resolveModel(provider, model, signal) {
		let entry = this.catalog.known(model);
		if (entry === void 0 && this.read().projectId !== "") {
			if (signal?.aborted === true) throw llmError(`${MODULE}: the request was cancelled`, "ABORTED");
			await this.catalog.list();
			entry = this.catalog.known(model);
		}
		if (entry === void 0) throw llmError(`${MODULE}: "${model}" is not in this route's model catalog; add it in the Models provider card`, "UNKNOWN_MODEL");
		return {
			provider,
			id: entry.id,
			name: entry.name,
			context: { contextWindow: entry.contextWindow ?? 1048576 },
			defaultMaxTokens: entry.maxTokens ?? 65536,
			inputModalities: ["text"],
			reasoning: {
				efforts: REASONING_EFFORTS.map((effort) => ({
					...effort,
					id: effortOf(effort.id)
				})),
				defaultEffort: effortOf("off")
			}
		};
	}
	/** @inheritdoc */
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
	/** @inheritdoc */
	async *stream(options) {
		const settings = this.read();
		if (settings.projectId === "") throw llmError(`${MODULE}: a Google Cloud project id is required; save it in the Models provider card`, "MISSING_CREDENTIAL");
		const rawKey = await this.host.resolveCredential(settings.apiKeyEnv);
		if (rawKey === void 0 || rawKey === "") throw llmError(`${MODULE}: no API key for "${settings.apiKeyEnv}"; save it in the Models provider card, or export ${settings.apiKeyEnv} in the launching environment`, "MISSING_CREDENTIAL");
		const apiKey = rawKey;
		const modelId = canonicalModelId(options.model);
		const projected = projectMessages(options, modelId);
		const contents = projected.contents;
		let droppedTrailing = 0;
		while (contents.length > 0 && contents[contents.length - 1]?.role === "model") {
			contents.pop();
			droppedTrailing += 1;
		}
		const systemInstruction = projected.systemInstruction;
		if (contents.length === 0) throw llmError(`${MODULE}: the request carries no model-visible content`, "INVALID_REQUEST");
		const generationConfig = { thinkingConfig: thinkingConfig(modelId, options.reasoningEffort) };
		if (typeof options.temperature === "number") generationConfig.temperature = options.temperature;
		if (Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0) generationConfig.maxOutputTokens = options.maxTokens;
		if (Array.isArray(options.stop) && options.stop.length > 0) generationConfig.stopSequences = [...options.stop];
		const body = {
			contents,
			generationConfig
		};
		if (systemInstruction !== void 0) body.systemInstruction = systemInstruction;
		const tools = buildTools(options.tools);
		if (tools !== void 0) body.tools = tools;
		const endpoint = parseEndpoint(endpointOf(settings.baseURL, settings.location));
		const path = `${endpoint.prefix}/v1/projects/${encodeURIComponent(settings.projectId)}/locations/${encodeURIComponent(settings.location)}/publishers/google/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
		const payload = JSON.stringify(body);
		const controller = new AbortController();
		let timedOut = false;
		const idle = Math.max(1e3, settings.streamIdleTimeoutMs);
		let timer;
		const armIdle = () => {
			if (timer !== void 0) clearTimeout(timer);
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, idle);
			timer.unref?.();
		};
		const onAbort = () => controller.abort();
		if (options.signal !== void 0) {
			if (options.signal.aborted) controller.abort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		const settle = () => {
			if (timer !== void 0) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		let response;
		try {
			armIdle();
			response = await performRequest(endpoint, settings.proxy, MODULE, {
				method: "POST",
				path,
				headers: {
					"content-type": "application/json",
					accept: "text/event-stream",
					"x-goog-api-key": apiKey,
					"content-length": String(Buffer.byteLength(payload))
				},
				body: payload
			}, controller.signal);
		} catch (error) {
			settle();
			if (timedOut) throw llmError(`${MODULE}: no response within ${idle} ms`, "TIMEOUT");
			if (controller.signal.aborted) throw llmError(`${MODULE}: the request was cancelled`, "ABORTED");
			if (error instanceof Error && error.code === "TRANSPORT") throw error;
			throw llmError(`${MODULE}: could not reach ${endpoint.host}: ${error instanceof Error ? error.message : String(error)}`, "TRANSPORT");
		}
		if (response.status < 200 || response.status >= 300) {
			const detail = providerErrorText(response.status, await readAll(response.stream, 4e3));
			recordRejectedRequest({
				status: response.status,
				detail,
				model: modelId,
				droppedTrailing,
				contents: contents.map((content) => ({
					role: content.role,
					parts: content.parts.map((part) => part.functionCall !== void 0 ? `call:${part.functionCall.name}` : part.functionResponse !== void 0 ? `response:${part.functionResponse.name}` : typeof part.text === "string" ? "text" : "other")
				}))
			});
			settle();
			throw llmError(`${MODULE}: ${response.status} ${detail}`, failureCode(response.status), { status: response.status });
		}
		const stream = response.stream;
		let buffer = "";
		let blockIndex = 0;
		let openKind;
		let openIndex = -1;
		let openText = "";
		let sawVisible = false;
		let sawToolCall = false;
		let finishReason;
		let usage;
		const parts = [];
		let callSeq = 0;
		const nextId = () => {
			callSeq += 1;
			const uuid = globalThis.crypto?.randomUUID?.();
			return typeof uuid === "string" ? `call_${uuid}` : `call_${callSeq}_${Date.now().toString(36)}`;
		};
		const closeOpen = function* () {
			if (openKind === void 0) return;
			yield {
				type: "block-end",
				index: openIndex,
				block: openKind === "text" ? {
					type: "text",
					text: openText
				} : {
					type: "reasoning",
					text: openText
				}
			};
			openKind = void 0;
			openIndex = -1;
			openText = "";
		};
		const ensureOpen = function* (kind) {
			if (openKind === kind) return;
			yield* closeOpen();
			openKind = kind;
			openIndex = blockIndex;
			blockIndex += 1;
			yield {
				type: "block-start",
				index: openIndex,
				blockType: kind
			};
		};
		try {
			try {
				for await (const chunk of stream) {
					armIdle();
					buffer += (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)).replace(/\r\n/g, "\n");
					let boundary = buffer.indexOf("\n\n");
					while (boundary !== -1) {
						const frame = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						boundary = buffer.indexOf("\n\n");
						const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
						if (data === "" || data === "[DONE]") continue;
						let event;
						try {
							event = JSON.parse(data);
						} catch {
							continue;
						}
						const record = event !== null && typeof event === "object" ? event : void 0;
						if (record === void 0) continue;
						const failure = record.error;
						if (failure !== null && typeof failure === "object") {
							const detail = typeof failure.message === "string" ? String(failure.message) : JSON.stringify(failure);
							const status = Number(failure.code);
							const code = status >= 100 && status <= 599 ? failureCode(status) : "SERVER";
							throw llmError(`${MODULE}: ${detail}`, code, status >= 100 && status <= 599 ? { status } : void 0);
						}
						const feedback = record.promptFeedback;
						if (feedback?.blockReason !== void 0 && !Array.isArray(record.candidates)) throw llmError(`${MODULE}: the prompt was blocked (${String(feedback.blockReason)})`, "INVALID_REQUEST");
						if (record.usageMetadata !== void 0 && record.usageMetadata !== null) usage = record.usageMetadata;
						const candidate = Array.isArray(record.candidates) ? record.candidates[0] : void 0;
						if (candidate === void 0) continue;
						if (typeof candidate.finishReason === "string") finishReason = candidate.finishReason;
						const list = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
						for (const part of list) {
							if (part === null || typeof part !== "object") continue;
							const item = part;
							const signature = typeof item.thoughtSignature === "string" ? item.thoughtSignature : void 0;
							if (typeof item.text === "string" && item.text !== "") {
								if (item.thought === true) {
									yield* ensureOpen("reasoning");
									openText += item.text;
									yield {
										type: "reasoning-delta",
										index: openIndex,
										text: item.text
									};
								} else {
									yield* ensureOpen("text");
									openText += item.text;
									yield {
										type: "text-delta",
										index: openIndex,
										text: item.text
									};
									sawVisible = true;
								}
								parts.push(signature === void 0 ? { ...item } : {
									...item,
									thoughtSignature: signature
								});
								continue;
							}
							if (item.functionCall !== void 0 && item.functionCall !== null) {
								yield* closeOpen();
								const name = typeof item.functionCall.name === "string" ? item.functionCall.name : "";
								if (name === "") continue;
								const args = JSON.stringify(item.functionCall.args ?? {});
								const id = nextId();
								const index = blockIndex;
								blockIndex += 1;
								sawVisible = true;
								sawToolCall = true;
								yield {
									type: "block-start",
									index,
									blockType: "tool-call"
								};
								yield {
									type: "tool-call-delta",
									index,
									id,
									name,
									argumentsDelta: args
								};
								yield {
									type: "block-end",
									index,
									block: {
										type: "tool-call",
										id,
										name,
										arguments: args
									}
								};
								parts.push(signature === void 0 ? { ...item } : {
									...item,
									thoughtSignature: signature
								});
							}
						}
					}
				}
			} catch (error) {
				if (error instanceof Error && typeof error.code === "string" && "failure" in error) throw error;
				if (timedOut) throw llmError(`${MODULE}: no data for ${idle} ms`, "TIMEOUT");
				if (controller.signal.aborted) throw llmError(`${MODULE}: the request was cancelled`, "ABORTED");
				throw llmError(`${MODULE}: the stream failed: ${error instanceof Error ? error.message : String(error)}`, "TRANSPORT");
			}
			yield* closeOpen();
			if (!sawVisible) throw llmError(`${MODULE}: the model returned no content${finishReason === void 0 ? "" : ` (finishReason ${finishReason})`}`, "EMPTY_RESPONSE");
			const promptTokens = Number(usage?.promptTokenCount) || 0;
			const candidateTokens = Number(usage?.candidatesTokenCount) || 0;
			const thoughtTokens = Number(usage?.thoughtsTokenCount) || 0;
			const totalTokens = Number(usage?.totalTokenCount) || promptTokens + candidateTokens + thoughtTokens;
			const cachedTokens = Number(usage?.cachedContentTokenCount) || 0;
			if (usage !== void 0) yield {
				type: "usage",
				usage: {
					inputTokens: promptTokens,
					outputTokens: candidateTokens + thoughtTokens,
					totalTokens,
					...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
					...thoughtTokens > 0 ? { reasoningTokens: thoughtTokens } : {}
				}
			};
			yield {
				type: "finish",
				reason: sawToolCall && (finishReason === void 0 || finishReason === "STOP" || finishReason === "MALFORMED_FUNCTION_CALL") ? { kind: "tool-calls" } : finishReason === "MAX_TOKENS" ? { kind: "max-tokens" } : { kind: "stop" },
				...parts.length > 0 ? { replayState: { response: {
					v: 1,
					model: modelId,
					parts
				} } } : {}
			};
		} finally {
			settle();
			stream.destroy();
		}
	}
};
//#endregion
//#region src/index.ts
/** Loader entry id; it is also the settings namespace the browser half writes. */
const ENTRY_ID = "llm-google-cloud";
/** Host plugin name, matching the package name. */
const name = "llm-google-cloud";
/** The `llm` service must exist before this plugin activates. */
const inject = ["llm"];
/** Mount the adapter for this bundle's one provider route. */
function apply(ctx, config) {
	const read = () => readConfig(config);
	const llm = ctx.llm;
	const adapter = new GoogleCloudAdapter({ async resolveCredential(ref) {
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(ref);
			if (hit !== void 0 && typeof hit.value === "string") return assertUsableKey(hit.value, MODULE, ref);
		}
		const ambient = process.env[ref];
		if (typeof ambient === "string" && ambient.length > 0) return assertUsableKey(ambient, MODULE, ref);
	} }, read);
	llm.registerAdapter([read().provider], adapter);
	const entryId = ctx.fiber?.entry?.options?.id;
	llm.registerConfigurableProviders([{
		provider: read().provider,
		displayName: read().displayName,
		settingsNs: entryId ?? "llm-google-cloud",
		settingsPath: []
	}]);
}
//#endregion
export { Config, ENTRY_ID, apply, inject, name, projectMessages };
