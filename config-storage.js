  // Store changed fields independently so stale tabs cannot replace credentials.
  const CONFIG_FIELD_PREFIX = `${CONFIG_STORAGE_KEY}:field:`;
  let configFieldBaseline = new Map();
  const configState = (config) => config.$state || config;
  const configFields = (value, path = [], fields = []) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => configFields(entry, [...path, getItemName(entry) === null ? String(index) : `@${entry.name}`], fields));
    } else if (isPlainObject(value)) {
      Object.entries(value).forEach(([key, entry]) => configFields(entry, [...path, key], fields));
    } else if (value === null || ["string", "boolean", "number"].includes(typeof value)) {
      fields.push({path, value, id: JSON.stringify(path)});
    }
    return fields;
  };
  const configChild = (target, step) => Array.isArray(target) && step.startsWith("@") ? target.find((entry) => getItemName(entry) === step.slice(1)) : target?.[step];
  const configFieldValue = (config, path) => path.reduce(configChild, configState(config));
  const setConfigField = (config, path, value) => {
    const parent = path.slice(0, -1).reduce(configChild, configState(config));
    if (!parent || !path.length) return false;
    parent[path[path.length - 1]] = value;
    return true;
  };
  const readConfigField = (text, expected) => {
    try {
      const record = typeof text === "string" ? JSON.parse(text) : null;
      if (!record || record.v !== 1 || !Object.prototype.hasOwnProperty.call(record, "value")) return {valid: false};
      const value = record.value;
      return {valid: typeof value === typeof expected && (typeof value !== "number" || Number.isFinite(value)), value};
    } catch {return {valid: false};}
  };
  const getStoredConfigText = () => {
    const value = _GM_getValue(CONFIG_STORAGE_KEY);
    return typeof value === "string" ? value : "";
  };
  const initializeConfigStorage = (config) => {
    for (const field of configFields(configState(config))) {
      const stored = readConfigField(_GM_getValue(CONFIG_FIELD_PREFIX + field.id), field.value);
      if (stored.valid) setConfigField(config, field.path, stored.value);
    }
    configFieldBaseline = new Map(configFields(configState(config)).map((field) => [field.id, field]));
    return config;
  };
  const persistConfig = (config) => {
    for (const field of configFields(configState(config))) {
      const previous = configFieldBaseline.get(field.id);
      if (!previous || Object.is(previous.value, field.value)) continue;
      _GM_setValue(CONFIG_FIELD_PREFIX + field.id, JSON.stringify({v: 1, value: field.value}));
      configFieldBaseline.set(field.id, field);
    }
  };
  const watchConfigStorage = (config) => {
    if (typeof _GM_addValueChangeListener !== "function") return () => {};
    const listeners = [];
    for (const field of configFields(configState(config))) {
      const listener = _GM_addValueChangeListener(CONFIG_FIELD_PREFIX + field.id, (_name, _old, text, remote) => {
        if (remote === false) return;
        const stored = readConfigField(text, field.value);
        const baseline = configFieldBaseline.get(field.id);
        if (!stored.valid || !baseline || !Object.is(configFieldValue(config, field.path), baseline.value)) return;
        configFieldBaseline.set(field.id, {...field, value: stored.value});
        setConfigField(config, field.path, stored.value);
      });
      listeners.push(listener);
    }
    return () => {
      if (typeof _GM_removeValueChangeListener !== "function") return;
      listeners.forEach((listener) => _GM_removeValueChangeListener(listener));
    };
  };
