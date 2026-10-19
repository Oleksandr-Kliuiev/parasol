/* Parasoll UX demo: interface strings in three languages (RU default, EN, NB).
   Keys are flat; a value can be a plural object { one, few, many, other }. */
(function () {
  'use strict';

  var P = window.P;
  P.locales = P.locales || {};
  P.languages = [
    { code: 'ru', label: 'Русский' },
    { code: 'en', label: 'English' },
    { code: 'nb', label: 'Norsk bokmål' }
  ];

  var rules = {};
  function plural(n) {
    var lang = P.state.lang;
    if (!rules[lang]) rules[lang] = new Intl.PluralRules(P.locale());
    return rules[lang].select(n);
  }

  function lookup(key) {
    var dict = P.locales[P.state.lang] || {};
    if (key in dict) return dict[key];
    return null;
  }

  /* t("key", { n: 3, name: "Ingrid" }): {n} picks the plural form and is formatted for the locale */
  P.t = function (key, params) {
    var v = lookup(key);
    if (v == null) {
      if (window.console) console.warn('[i18n] missing key', P.state.lang, key);
      return key;
    }
    if (typeof v === 'object') {
      var n = params && typeof params.n === 'number' ? params.n : 0;
      v = v[plural(n)] || v.other || v.many || v.one;
    }
    if (params) {
      v = v.replace(/\{(\w+)\}/g, function (m, name) {
        if (!(name in params)) return m;
        var value = params[name];
        return typeof value === 'number' ? P.fmt.num(value) : String(value);
      });
    }
    return v;
  };

  /* Synthetic user-written content carries its own translations: { ru, en, nb } */
  P.L = function (value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return value[P.state.lang] || value.en || value.ru || '';
  };

  P.applyLang = function () {
    document.documentElement.lang = P.state.lang === 'nb' ? 'nb' : P.state.lang;
  };
})();
