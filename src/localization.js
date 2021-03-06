angular.module('ngLocalize')
    .service('locale', function ($injector, $http, $q, $log, $rootScope, $window, localeConf, localeEvents, localeSupported, localeFallbacks) {
        var TOKEN_REGEX = localeConf.validTokens || new RegExp('^([\\w-]+\\/)*([\\w-]+\\.)+([\\w\\s-])+\\w(:.*)?$'),
            $html = angular.element(document.body).parent(),
            currentLocale,
            deferrences,
            bundles,
            cookieStore,
            sym = localeConf.allowNestedJson ? '/' : '.';

        if (localeConf.persistSelection && $injector.has('$cookieStore')) {
            cookieStore = $injector.get('$cookieStore');
        }

        function splitToken(tok){
            var key, path;
            if (localeConf.allowNestedJson){
                var split = tok ? tok.split('.') : [];
                key = split.length > 1 ? split.slice(1) : '';
                path = split.length > 0 ? split[0].split(sym) : [];
                path.push(split.length > 1 ? split[1] : '');
            } else {
                path = tok ? tok.split('/').join('.').split('.') : [];
                key = path.length > 1 ? path[path.length - 1] : '';
            }
            return {
                key: key,
                path: path
            };
        }

        function isToken(str) {
            return (str && str.length && TOKEN_REGEX.test(str));
        }

        function getPath(tok) {
            var path = splitToken(tok).path,
                result = '';

            if (path.length > 1) {
                result = path.slice(0, -1).join(sym);
            }

            return result;
        }

        function getKey(tok) {
            return splitToken(tok).key;
        }

        function getBundle(tok) {
            var result = null,
                path = splitToken(tok).path,
                i;

            if (path.length > 1) {
                result = bundles;

                for (i = 0; i < path.length - 1; i++) {
                    if (result[path[i]]) {
                        result = result[path[i]];
                    } else {
                        result = null;
                        break;
                    }
                }
            }

            return result;
        }

        function isFrozen (obj) {
            return (Object.isFrozen || function (obj) {
                return obj && obj.$$frozen;
            })(obj);
        }

        function freeze (obj) {
            return (Object.freeze || function (obj) {
                if (obj) {
                    obj.$$frozen = true;
                }
            })(obj);
        }

        // http://stackoverflow.com/a/17606289
        function replaceAll(str, substr, sub) {
            return str.replace(new RegExp(substr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), sub);
        }

        function loadBundle(token) {
            var path = splitToken(token).path,
                root = bundles,
                parent,
                locale = currentLocale,
                url = localeConf.basePath + '/' + locale,
                ref,
                i;

            if (path.length > 1) {
                for (i = 0; i < path.length - 1; i++) {
                    ref = path[i];
                    if (!root[ref]) {
                        root[ref] = {};
                    }
                    parent = root;
                    root = root[ref];
                    url += '/' + ref;
                }

                if (isFrozen(root)) {
                    root = angular.extend({}, root);
                }
                if (!root._loading) {
                    root._loading = true;

                    url += localeConf.fileExtension;

                    $http.get(url)
                        .then(function (response) {
                            var key,
                                path = getPath(token),
                                data = response.data;
                            // Merge the contents of the obtained data into the stored bundle.
                            for (key in data) {
                                if (data.hasOwnProperty(key)) {
                                    root[key] = data[key];
                                }
                            }

                            // Mark the bundle as having been "loaded".
                            delete root._loading;
                            parent[ref] = freeze(root);
                            root = null;

                            // Notify anyone who cares to know about this event.
                            $rootScope.$broadcast(localeEvents.resourceUpdates, {
                                locale: locale,
                                path: path,
                                bundle: parent[ref]
                            });

                            // If we issued a Promise for this file, resolve it now.
                            if (deferrences[path]) {
                                deferrences[path].resolve(path);
                            }
                        }, function (err) {
                            var path = getPath(token);

                            $log.error('[localizationService] Failed to load: ' + url);

                            // We can try it again later.
                            delete root._loading;

                            // If we issued a Promise for this file, reject it now.
                            if (deferrences[path]) {
                                deferrences[path].reject(err.data);
                            }
                        });
                }
            }
        }

        function bundleReady(path) {
            var bundle,
                token;

            path = path || localeConf.langFile;
            token = path + '._LOOKUP_';
            bundle = getBundle(token);

            if (!deferrences[path]) {
                deferrences[path] = $q.defer();
            }

            if (bundle && !bundle._loading) {
                deferrences[path].resolve(path);
            } else {
                if (!bundle) {
                    loadBundle(token);
                }
            }

            return deferrences[path].promise;
        }

        function ready(path) {
            var paths,
                deferred,
                outstanding;

            if (angular.isString(path)) {
                paths = path.split(',');
            } else if (angular.isArray(path)) {
                paths = path;
            } else {
                throw new Error('locale.ready requires either an Array or comma-separated list.');
            }

            if (paths.length > 1) {
                outstanding = [];
                paths.forEach(function (path) {
                    outstanding.push(bundleReady(path));
                });
                deferred = $q.all(outstanding);
            } else {
                deferred = bundleReady(path);
            }

            return deferred;
        }

        function applySubstitutions(text, subs) {
            var res = text,
                firstOfKind = 0;

            if (subs) {
                if (angular.isArray(subs)) {
                    angular.forEach(subs, function (sub, i) {
                        res = replaceAll(res, '%' + (i + 1), sub);
                        res = replaceAll(res, '{' + (i + 1) + '}', sub);
                    });
                } else {
                    angular.forEach(subs, function (v, k) {
                        ++firstOfKind;

                        res = replaceAll(res, '{' + k + '}', v);
                        res = replaceAll(res, '%' + k, v);
                        res = replaceAll(res, '%' + (firstOfKind), v);
                        res = replaceAll(res, '{' + (firstOfKind) + '}', v);
                    });
                }
            }
            res = res.replace(/\n/g, '<br>');

            return res;
        }

        function getLocalizedString(txt, subs) {
            var result = '',
                bundle,
                key,
                A,
                isValidToken = false;

            if (angular.isString(txt) && !subs && txt.indexOf(localeConf.delimiter) !== -1) {
                A = txt.split(localeConf.delimiter);
                txt = A[0];
                subs = angular.fromJson(A[1]);
            }

            isValidToken = isToken(txt);
            if (isValidToken) {
                if (!angular.isObject(subs)) {
                    subs = [subs];
                }

                bundle = getBundle(txt);
                if (bundle && !bundle._loading) {
                    key = getKey(txt);
                    if (localeConf.allowNestedJson){
                        for (var i = 0; i < key.length - 1; i++) {
                            if (bundle[key[i]]) {
                                bundle = bundle[key[i]];
                            } else {
                                bundle = null;
                                break;
                            }
                        }
                        key =  key[key.length -1];
                    }
                    if (bundle[key]) {
                        if (angular.isString(bundle[key])){
                            result = applySubstitutions(bundle[key], subs);
                        } else {
                            $log.info('[localizationService] Key is not a string: ' + txt + '. Is it a nested object?');
                            result = '%%KEY_NOT_STRING%%';
                        }
                    } else {
                        $log.info('[localizationService] Key not found: ' + txt);
                        result = '%%KEY_NOT_FOUND%%';
                    }
                } else {
                    if (!bundle) {
                        loadBundle(txt);
                    }
                }
            } else {
                result = txt;
            }

            return result;
        }

        function updateHtmlTagLangAttr(lang) {
            lang = lang.split('-')[0];

            $html.attr('lang', lang);
        }

        function getLanguageSupported(language) {
            var foundLanguage = null;
            if (language && language.length) {
                localeSupported.forEach(function (languageSuppported) {
                    if (languageSuppported.indexOf(language) === 0) {
                        foundLanguage = languageSuppported;
                        return;
                    }
                });
                if (!foundLanguage) {
                    var fallbackLang = localeFallbacks[language.split('-')[0]];
                    if (!angular.isUndefined(fallbackLang)) {
                      foundLanguage = fallbackLang;
                    }
                }
            }
            return foundLanguage || localeConf.defaultLocale;
        }

        function setLocale(value) {
            var lang;

            if (angular.isString(value) && value.length ) {
                value = value.trim();
                lang = getLanguageSupported(value);
            } else {
                lang = localeConf.defaultLocale;
            }

            if (lang !== currentLocale) {
                bundles = {};
                deferrences = {};
                currentLocale = lang;

                updateHtmlTagLangAttr(lang);

                $rootScope.$broadcast(localeEvents.localeChanges, currentLocale);

                if (cookieStore) {
                    cookieStore.put(localeConf.cookieName, lang);
                }
            }
        }

        function getLocale() {
            return currentLocale;
        }

        function getPreferredBrowserLanguage() {
            var nav = $window.navigator,
                browserLanguagePropertyKeys = ['language', 'browserLanguage', 'systemLanguage', 'userLanguage'],
                i,
                language;

            // support for HTML 5.1 "navigator.languages"
            if (angular.isArray(nav.languages)) {
                for (i = 0; i < nav.languages.length; i++) {
                    language = nav.languages[i];
                    if (language) {
                        return language;
                    }
                }
            }
            // support for other well known properties in browsers
            for (i = 0; i < browserLanguagePropertyKeys.length; i++) {
                language = nav[browserLanguagePropertyKeys[i]];
                if (language) {
                    return language;
                }
            }

            return null;
        }

        function initialSetLocale() {
            setLocale(cookieStore && cookieStore.get(localeConf.cookieName) ?
                cookieStore.get(localeConf.cookieName) :
                getPreferredBrowserLanguage());
        }

        initialSetLocale();

        return {
            ready: ready,
            isToken: isToken,
            getPath: getPath,
            getKey: getKey,
            setLocale: setLocale,
            getLocale: getLocale,
            getString: getLocalizedString,
            getPreferredBrowserLanguage: getPreferredBrowserLanguage
        };
    });
