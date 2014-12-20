/**
 * Durandal 2.1.0 Copyright (c) 2012 Blue Spire Consulting, Inc. All Rights Reserved.
 * Available via the MIT license.
 * see: http://durandaljs.com or https://github.com/BlueSpire/Durandal for details.
 */
/*
 * - Cleanup and re-design of hierarchical routers
 * - Role based route authorization
 * arash.shakery@gmail.com, May 2014
 */
/**
 * Connects the history module's url and history tracking support to Durandal's activation and composition engine allowing you to easily build navigation-style applications.
 * @module router
 * @requires system
 * @requires app
 * @requires activator
 * @requires events
 * @requires composition
 * @requires history
 * @requires knockout
 * @requires jquery
 */
define(['durandal/system', 'durandal/app', 'durandal/activator', 'durandal/events', 'durandal/composition', 'durandal/viewEngine', 'plugins/history', 'knockout', 'jquery'], function (system, app, activator, events, composition, viewEngine, history, ko, $) {
    var startDeferred, rootRouter;
    var routesAreCaseSensitive = false;
    var contextRouter = [];


    // TODO: Cancel Back

    var RouteInfo = (function () {
        var optionalParam = /\((.*?)\)/g;
        var namedParam = /(\(\?)?:\w+/g;
        var splatParam = /(\/*)\*\w+/g;
        var escapeRegExp = /[\-{}\[\]+?.,\\\^$|#\s]/g;
        var allParams = /(\:|\*)(\w+)/g;

        return RouteInfo;

        function routeStringToRegExp(routeString) {
            routeString = routeString
                .replace(escapeRegExp, '\\$&')
                .replace(optionalParam, '(?:$1)?')
                .replace(namedParam, function (match, optional) {
                    return optional ? match : '([^\/]+)';
                })
                .replace(splatParam, '(?:$1(.+?)|$)');

            return new RegExp('^' + routeString + '$', routesAreCaseSensitive ? undefined : 'i');
        }

        function RouteInfo(routeString) {
            if (!(this instanceof RouteInfo))
                return routeString instanceof RouteInfo
                    ? routeString
                    : new RouteInfo(routeString);

            var that = this;
            that.route = routeString;
            that.regex = routeStringToRegExp(routeString);
            that.params = routeString.match(allParams) || [];
            that.test = function (str) { return that.regex.test(str); };
            that.exec = function (str) { return that.regex.exec(str); };
            that.withFragment = function (fragment) { return new RouteFragment(fragment, that); };
        }

        function RouteFragment(fragment, routeInfo, backPiper) {
            var me = this;
            me.fragment = fragment;
            me.routeInfo = RouteInfo(routeInfo);
            me.backPiper = backPiper || function (x) { return x; };

            var params;
            me.getParams = function () {
                return params = params || me.routeInfo.exec(me.fragment).slice(1);
            };

            me.stripParams = function (route) {
                return piper(me.routeInfo, route.replace('*childRoutesFragment', ''))(me.fragment)
                    .replace(/\(([^)]*(\:|\*)[^)]*)*\)/g, '')
                    .replace(splatParam, '$1')
                    .replace(/\(|\)/g, '');
            };

            me.reduce = function (route) {
                return route instanceof RouteInfo
                    ? new RouteFragment(me.fragment, route, me.backPiper)
                    : me.backPiper(route === undefined ? me.fragment : route);
            };

            me.map = function (nextRoute) {
                if (!(nextRoute instanceof RouteInfo)) {
                    if (typeof nextRoute != 'string') {
                        if (!nextRoute) return me;
                        nextRoute = me.routeInfo.params.join('/');
                    }
                    nextRoute = new RouteInfo(nextRoute);
                }

                var nextFragment = piper(me.routeInfo, nextRoute.route)(me.fragment);
                var nextParent = me.backPiper(filter(me.routeInfo, nextRoute)(me.fragment));
                var nextBackPiper = piper(nextRoute, nextParent);
                return new RouteFragment(nextFragment, nextRoute, nextBackPiper);
            };
        }

        function piper(r1, r2) {
            var piper = r2.replace(allParams, function (p) {
                var ind = r1.params.indexOf(p);
                return ind == -1 ? p : ('$' + (ind + 1));
            });
            return function (str) {
                return str.replace(r1.regex, piper);
            };
        }

        function filter(r1, r2) {
            var filter = r1.route.replace(allParams, function (p) {
                var ind = r2.params.indexOf(p);
                return ind == -1 ? '$' + (r1.params.indexOf(p) + 1) : p;
            });
            return function (str) {
                return str.replace(r1.regex, filter);
            };
        }
    })();


    // -----------------------------------------------------------------------------------------------------------------

    function stripParametersFromRoute(route) {
        return route
            .replace(/\/*(\(|\)|:|\*).*$/g, '')
            .replace(/(^\/+)|(\/+$)/g, '')
            .replace(/\/{2,}/g, '/');
    }

    function endsWith(str, suffix) {
        return str.indexOf(suffix, str.length - suffix.length) !== -1;
    }

    function compareArrays(first, second) {
        if (!first && !second) return true;

        if (!first || !second || first.length != second.length) return false;

        for (var i = 0, len = first.length; i < len; i++)
            if (first[i] != second[i])
                return false;

        return true;
    }

    function extendNavigationOptions(options) {
        var replace = options && options.replace;
        var trigger = (options === undefined) ||
            (system.isBoolean(options) && options) ||
            (system.isObject(options) && (options.trigger || options.trigger === undefined));

        if (!system.isObject(options))
            options = { };

        options.trigger = !!trigger;
        options.replace = !!replace;

        return options;
    }

    function deepClone(obj) {
        if (!obj || !system.isObject(obj) || ko.isObservable(obj)) return obj;

        if (Array.isArray(obj))
            return obj.map(function (item) { return deepClone(item) });

        var res = {};
        for (var p in obj)
            if (obj.hasOwnProperty(p) && p[0] !== '_' && p[0] !== '$')
                res[p] = deepClone(obj[p]);
        return res;
    }

    function construct(fCtor, aArgs) {
        if (!Array.isArray(aArgs))
            aArgs = deepClone(Array.prototype.slice.call(arguments, 1));

        var fNewCtor = function () {
            var res = fCtor.apply(this, aArgs);
            if (res !== undefined) return res;
        };
        fNewCtor.prototype = fCtor.prototype;
        return new fNewCtor();
    }

    function toPromise(x) {
        // where ever we don't know result of some function is promise or not
        // we simply convert to promise and treat them in same way, so no code duplicates.
        if (x && x.then) return x;
        return system.defer(function (dfd2) { dfd2.resolve(x); }).promise();
    }

    var noOperation = function (instance) { return toPromise(function () { return toPromise(instance); }); };


    /**
     * @class Router
     * @uses Events
     */

    /**
     * Triggered when the navigation logic has completed.
     * @event router:navigation:complete
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered when the navigation has been cancelled.
     * @event router:navigation:cancelled
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered when navigation begins.
     * @event router:navigation:processing
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered right before a route is activated.
     * @event router:route:activating
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered right before a route is configured.
     * @event router:route:before-config
     * @param {object} config The route config.
     * @param {Router} router The router.
     */

    /**
     * Triggered just after a route is configured.
     * @event router:route:after-config
     * @param {object} config The route config.
     * @param {Router} router The router.
     */

    /**
     * Triggered when the view for the activated instance is attached.
     * @event router:navigation:attached
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered when the composition that the activated instance participates in is complete.
     * @event router:navigation:composition-complete
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered when the router does not find a matching route.
     * @event router:route:not-found
     * @param {string} fragment The url fragment.
     * @param {Router} router The router.
     */

    var createRouter = function () {
        var currentActivation,
            currentInstruction,
            activeItem = activator.create(),
            isProcessing = ko.observable(false);

        var router = {
            /**
             * The route handlers that are registered. Each handler consists of a `routePattern` and a `callback`.
             * @property {object[]} handlers
             */
            handlers: [],
            /**
             * The route configs that are registered.
             * @property {object[]} routes
             */
            routes: [],
            /**
             * The route configurations that have been designated as displayable in a nav ui (nav:true).
             * @property {KnockoutObservableArray} navigationModel
             */
            navigationModel: ko.observableArray([]),
            routesIds: ko.observable({}),
            /**
             * The active item/screen based on the current navigation state.
             * @property {Activator} activeItem
             */
            activeItem: activeItem,
            /**
             * Indicates that the router (or a child router) is currently in the process of navigating.
             * @property {KnockoutComputed} isNavigating
             */
            isNavigating: ko.computed(function () {
                var current = activeItem();
                var processing = isProcessing();
                var currentRouterIsProcessing = current
                    && current.router
                    && current.router != router
                    && current.router.isNavigating() ? true : false;
                return  processing || currentRouterIsProcessing;
            }),
            /**
             * An observable surfacing the active routing instruction that is currently being processed or has recently finished processing.
             * The instruction object has `config`, `fragment`, `queryString`, `params` and `queryParams` properties.
             * @property {KnockoutObservable} activeInstruction
             */
            activeInstruction: ko.observable(null),
            __router__: true
        };


        events.includeIn(router);
        activeItem.settings.areSameItem = function (currentItem, newItem, currentActivationData, newActivationData) {
            return currentItem == newItem
                && compareArrays(currentActivationData, newActivationData);
        };


        // ------------------------------------------------------------------------------------------------------

        function withContextRouter(fn) {
            contextRouter.push(router);
            var res = fn();
            if (res && res.then)
                return res.then(function (x) {
                    contextRouter.pop();
                    return  x;
                }).fail(function (err) {
                    contextRouter.pop();
                    throw err;
                });
            contextRouter.pop();
            return res;
        }

        function hasChildRouter(instance) {
            if (instance && instance.__activeRouter__ && !instance.__activeRouter__.deactivated)
                return instance.__activeRouter__;

            if (instance && instance.router && instance.router.__router__ && instance.router.parent == router)
                return instance.router;
        }

        function getChildRouter(instance) {
            var alreadyHas = hasChildRouter(instance);
            if (alreadyHas) return alreadyHas;
            else {
                if (instance && system.isFunction(instance.getRouter)) {
                    var result;

                    try {
                        result = instance.getRouter.apply(instance, router.activeInstruction().params);
                    } catch (error) {
                        system.log('ERROR: ' + error.message, error);
                        return;
                    }

                    return toPromise(result).then(function (rt) {
                        if (rt && rt.__router__ && rt.parent == parentRouter) return rt;
                    });
                }
            }
        }

        function setCurrentInstructionRouteIsActive(flag) {
            if (currentInstruction && currentInstruction.config.isActive) {
                currentInstruction.config.isActive(flag);
            }
        }

        function startNavigation(instruction) {
            system.log('Navigation Started', instruction);
            router.activeInstruction(instruction);
            router.trigger('router:navigation:processing', instruction, router);
        }

        function cancelNavigation(instruction) {
            system.log('Navigation Cancelled', instruction);
            router.activeInstruction(currentInstruction);
            router.trigger('router:navigation:cancelled', instruction, router);
        }

        function completeNavigation(instance, instruction) {
            var fromModuleId = system.getModuleId(currentActivation);
            if (fromModuleId) {
                router.trigger('router:navigation:from:' + fromModuleId);
            }

            var previousActivation = currentActivation;
            currentActivation = instance;

            setCurrentInstructionRouteIsActive(false);
            currentInstruction = instruction;
            setCurrentInstructionRouteIsActive(true);

            var toModuleId = system.getModuleId(currentActivation);
            if (toModuleId) {
                router.trigger('router:navigation:to:' + toModuleId);
            }

            if (instance && !hasChildRouter(instance, router)) {
                router.updateDocumentTitle(instance, instruction);
            }

            router.trigger('router:navigation:complete', instance, instruction, router);

            if (previousActivation == instance) {
                router.attached();
                router.compositionComplete();
            }

            system.log('Navigation Complete', instance, instruction);
        }


        function activateRoute(activator, instance, instruction) {
            // activateItem2 only invokes canDeactivate/canActivate calls,
            // and if they resolve to true, activateItem2 resolves to some callback function
            // invoking this callback function continues the process of deactivate/activate calls.
            // Callback function is only invoked in "rootRouter.loadUrl", so in all other places
            // where we need to orchestrate some actions right before/after of complete deactivate/activate
            // (like current function activateRoute), we invoke callback in a wrapped function and return the new one.


            return activator.activateItem2(instance, instruction.params)
                .then(function (canContinueCb) {
                    return canContinueCb && function () {
                        router.trigger('router:route:activating', instance, instruction, router);
                        return canContinueCb().then(function (success) {
                            if (!success)
                                throw new Error('An unexpected error has occurred while activating.');

                            if (instruction.config)
                                currentRouteId(instruction.config.id || instruction.config.route);

                            // return activated instance for further use
                            return instance;
                        });
                    };
                });
        }


        /**
         * Inspects routes and modules before activation. Can be used to protect access by cancelling navigation or redirecting.
         * @method guardRoute
         * @param {object} instance The module instance that is about to be activated by the router.
         * @param {object} instruction The route instruction. The instruction object has config, fragment, queryString, params and queryParams properties.
         * @return {Promise|Boolean|String} If a boolean, determines whether or not the route should activate or be cancelled. If a string, causes a redirect to the specified route. Can also be a promise for either of these value types.
         */
        function handleGuardedRoute(activator, instance, instruction) {
            return toPromise(router.guardRoute(instance, instruction))
                .then(function (result) {
                    if (system.isString(result)) {
                        // if some router's guardRoute returns a string, it's treated as redirect
                        // and also if router is fromParent=true, redirect url is relative to this router.
                        router.navigate(result);
                        return false;
                    }
                    return result && activateRoute(activator, instance, instruction);
                });
        }


        function ensureActivation(activator, instance, instruction) {
            if (router.guardRoute) {
                return handleGuardedRoute(activator, instance, instruction);
            } else {
                return activateRoute(activator, instance, instruction);
            }
        }

        function getChildRouterCanContinue(instance, instruction) {
            return toPromise(getChildRouter(instance, router))
                .then(function (childRouter) {
                    // if there's no child, return a callback function which does nothing.
                    if (!childRouter) return noOperation();

                    // If there's any child router, recursively ask whether it can continue with fragment.
                    return childRouter.loadFragment(instruction).then(function (childContinue) {
                        return childContinue && function () {
                            instance.__activeRouter__ = childRouter;
                            instance.__activeRouter__.deactivated = false;

                            return childContinue();
                        }
                    })
                });
        }


        function getInstructionCanContinue(instruction, reuse) {
            // case 1: router is going to be deactivated (by parent router), so activeItem must deactivate too.
            if (instruction.deactivate) {
                if (!currentActivation) return noOperation();
                return activeItem.canDeactivate(true)
                    .then(function (canDeactivate) {
                        return canDeactivate && function () {
                            return activeItem.forceDeactivate(true)
                                .then(function (deactivated) {
                                    if (!deactivated)
                                        throw new Error('An unexpected error has occurred while deactivating.');

                                    router.deactivated = true;
                                    return undefined;
                                });
                        };
                    });
            }

            // case 2: module is reusable (canReuseForRoute has returned true, or module has a child router)
            if (reuse) {
                // If canReuseForRoute returns {reactivate: false} we don't execute module's activation life-cycle hooks.
                // even though that, compositionComplete and attached will be invoked.
                if (system.isObject(reuse) && reuse.reactivate !== undefined && !reuse.reactivate)
                    return toPromise(function () {
                        router.trigger('router:route:activating', currentActivation, instruction, router);
                        return currentActivation;
                    });
                else {
                    var tempActivator = activator.create();
                    tempActivator.forceActiveItem(currentActivation); //enforce lifecycle without re-compose
                    tempActivator.settings.areSameItem = activeItem.settings.areSameItem;
                    tempActivator.settings.closeOnDeactivate = false;

                    return ensureActivation(tempActivator, currentActivation, instruction);
                }
            }

            if (system.isObject(instruction.config.module)) {
                return ensureActivation(activeItem, instruction.config.module, instruction);
            }

            // case 3: only view
            if (!instruction.config.moduleId) {
                return ensureActivation(activeItem, {
                    viewUrl: instruction.config.viewUrl,
                    canReuseForRoute: function () {
                        return true;
                    }
                }, instruction);
            }

            // case 4: cannot reuse module
            return system.acquire(instruction.config.moduleId)
                .then(function (m) {
                    var instance = (system.isFunction(m) && instruction.config.constructionData)
                        ? construct(m, instruction.config.constructionData)
                        : system.resolveObject(m);

                    if (instruction.config.viewUrl) {
                        instance.viewUrl = instruction.config.viewUrl;
                    }

                    // here activation calls are invoked in a interleaving fashion
                    // first we invoke canDeactivate/canActivate of current/new module
                    return ensureActivation(activeItem, instance, instruction)
                        .then(function (canContinueModule) {

                            // then if canContinueModule is a callback, we must recursively invoke canActivate of
                            // new child router. (canDeactivate is already called in a previous call to case 1)
                            return canContinueModule && getChildRouterCanContinue(instance, instruction)
                                .then(function (canContinueChilds) {

                                    // if childs permits too, then we return a new callback function
                                    // which invokes deactivate/activate of current level, followed by childs.
                                    return canContinueChilds && function () {
                                        return canContinueModule().then(function (activatedModule) {
                                            return canContinueChilds().then(function (activatedChild) {
                                                return activatedModule;
                                            });
                                        });
                                    };
                                });
                        });
                }, function(e) {
                    system.log('Cannot acquire module.', e);
                    return false;
                });
        }

        function canReuseCurrentActivation(instruction) {
            if (!currentActivation || !currentInstruction
                || currentInstruction.config.moduleId != instruction.config.moduleId
                || currentInstruction.config.constructionData !== instruction.config.constructionData)
                return false;

            if (system.isFunction(currentActivation.canReuseForRoute)) {
                try {
                    return currentActivation.canReuseForRoute.apply(currentActivation, instruction.params);
                }
                catch (error) {
                    system.log('ERROR: ' + error.message, error);
                    return false;
                }
            }

            return hasChildRouter(currentActivation) || system.isFunction(currentActivation.getRouter);
        }


        function processInstruction(instruction) {
            // Navigation starts.
            startNavigation(instruction);


            // canReuseForRoute may return a promise.
            return toPromise(canReuseCurrentActivation(instruction))
                .then(function (canReuse) {

                    // If canReuse is false, current child router must deactivate.
                    var childInstruction = canReuse ? instruction : { deactivate: true };

                    // check canDeactivate/canActivate of childs
                    return getChildRouterCanContinue(currentActivation, childInstruction)
                        .then(function (canContinueChilds) {

                            // Only if childs permit, check canDeactivate/canActivate of current.
                            return canContinueChilds && getInstructionCanContinue(instruction, canReuse)
                                .then(function (instructionCb) {
                                    return instructionCb && function () {

                                        // Call child's deactivate/activate followed by current.
                                        return canContinueChilds().then(instructionCb);
                                    };
                                });
                        });

                })
                .then(function (canContinueAll) {
                    if (!canContinueAll) cancelNavigation(instruction);

                    return canContinueAll && function () {
                        return canContinueAll().then(function (instance) {
                            completeNavigation(instance, instruction);

                            return instance;
                        });
                    };
                });
        }


        var fragmentQueue = [];
        router.loadFragment = function (fragment) {
            if (isProcessing()) {
                return system.defer(function (dfd) {
                    if (fragmentQueue.length < 3)
                        fragmentQueue.push(dfd);
                    else
                        dfd.resolve(false);
                }).promise().then(function (x) {
                    return x && router.loadFragment(fragment);
                });
            }

            isProcessing(true);
            return withContextRouter(function () {
                return toPromise(processFragment(fragment))
                    .then(function (instruction) {
                        if (instruction === false) return false;
                        if (!instruction) return noOperation(undefined);
                        if (!instruction.config) instruction.config = {};
                        return processInstruction(instruction);
                    });
            }).then(function (canContinue) {
                if (!canContinue) {
                    dequeueNextFragment();
                }

                return canContinue && function () {
                    return withContextRouter(canContinue)
                        .fail(function (error) {
                            dequeueNextFragment();
                            system.log('ERROR on navigation', error);
                            throw error;
                        });
                };
            });
        };

        function dequeueNextFragment() {
            isProcessing(false);
            var dfd = fragmentQueue.shift();
            if (dfd) dfd.resolve(true);
        }

        router.attached = function () {
            router.trigger('router:navigation:attached', currentActivation, currentInstruction, router);
        };

        router.compositionComplete = function () {
            dequeueNextFragment();
            router.trigger('router:navigation:composition-complete', currentActivation, currentInstruction, router);
        };


        // -------------------------------------------------------------------------------------------------------------


        function processFragment(fragment) {
            var coreFragment, queryString, queryParams, routeFragment;

            if (typeof fragment == 'object') {
                if (fragment.deactivate) return fragment;

                routeFragment = fragment.routeFragment.map(router.fromParent);
                coreFragment = routeFragment.fragment;
                queryString = fragment.queryString;
                queryParams = fragment.queryParams;
            }
            else {
                queryString = null;
                coreFragment = fragment;
                var queryIndex = fragment.indexOf('?');
                if (queryIndex != -1) {
                    coreFragment = fragment.substring(0, queryIndex);
                    queryString = fragment.substr(queryIndex + 1);
                }
                queryParams = router.parseQueryString(queryString);
                routeFragment = (new RouteInfo('*all')).withFragment(coreFragment);
            }
            // coreFragment = normalizeFragment(coreFragment);


            var handlers = router.handlers;
            for (var i = 0; i < handlers.length; i++) {
                var current = handlers[i];

                // if pattern is a matcher
                if (current.routePattern instanceof RouteInfo) {
                    if (current.routePattern.test(coreFragment)) {
                        var resultingConfig = current.callback(coreFragment);
                        var newRouteFragment = routeFragment.reduce(current.routePattern);

                        var params = newRouteFragment.getParams();
                        if (queryParams) params.push(queryParams);

                        var instruction = {
                            routeFragment: newRouteFragment,
                            fragment: coreFragment,
                            queryString: queryString,
                            config: resultingConfig,
                            params: params,
                            queryParams: queryParams
                        };

                        if (!authorize(instruction.config.authorize, instruction)) continue;

                        return resultingConfig.initialize
                            ? toPromise(resultingConfig.initialize(instruction)).then(function (res) { return res || instruction })
                            : instruction;
                    }
                }

                // if registered from outside, is a real regular expression
                else if (current.routePattern.test(coreFragment)) {
                    current.callback(coreFragment, queryString);
                    return;
                }
            }

            system.log('Route Not Found', coreFragment, currentInstruction, fragment);
            router.trigger('router:route:not-found', coreFragment, router, fragment);
            return false;
        }


        // if config has authorize attribute, check if it is authorized to execute
        // instruction is passed in, just for flexibility when developer may override hasPermission of router.
        function authorize(token, instruction) {
            if (ko.isObservable(token)) return authorize(token());
            if (typeof token == 'boolean') return token;

            if (typeof token == 'string') {
                return token[0] == '!'
                    ? !router.hasPermission(token.substring(1), instruction)
                    : router.hasPermission(token, instruction);
            }

            if (typeof token == 'function')
                return authorize(token.apply(instruction.config, [router, instruction]), instruction);

            if (Array.isArray(token))
                for (var i = 0; i < token.length; i++)
                    if (!authorize(token[i], instruction))
                        return false;

            return typeof token == 'undefined' || !!token;
        }

        // ---------------------------------------- Route Configuration ------------------------------------------------

        /**
         * Add a route to be tested when the url fragment changes.
         * @method route
         * @param {RegEx} routePattern The route pattern to test against.
         * @param {function} callback The callback to execute when the route pattern is matched.
         */
        router.route = function (routePattern, callback) {
            router.handlers.push({ routePattern: routePattern, callback: callback });
        };


        function configureRoute(config) {
            router.trigger('router:route:before-config', config, router);

            config.isActive = config.isActive || ko.observable(false);
            config.isAuthorized = ko.computed(function () {
                return authorize(config.authorize, { config: config });
            });

            if (typeof config.route == 'string') {
                config.title = config.title || router.convertRouteToTitle(config.route);

                if (!config.viewUrl)
                    config.moduleId = config.moduleId || router.convertRouteToModuleId(config.route);

                if (config.hasChildRoutes)
                    config.route = config.route + (endsWith(config.route, '/') || config.route == '' ? '' : '/') + '*childRoutesFragment';

                if (typeof config.hash != 'string') {
                    config.hash = ko.observable(config.route);
                    router.on('router:navigation:complete', function (instance, instruction) {
                        if (instruction.deactivate) return;

                        var rf = instruction.routeFragment;
                        var hash = rf.reduce(rf.stripParams(config.route)).replace(/(^\/*)|(\/*$)/g, '');
                        hash = (history._hasPushState ? '/' : '#') + hash;
                        config.hash(hash);
                    });
                }
            }

            else if (!system.isRegExp(config.route))
                throw new Error('Invalid config.route provided.');

            config.routePattern = new RouteInfo(config.route);

            router.trigger('router:route:after-config', config, router);
            router.routes.push(config);
            router.route(config.routePattern, function () { return config; });
        }


        function mapRoute(config) {
            if (system.isArray(config.route)) {
                var isActive = config.isActive || ko.observable(false);

                for (var i = 0, length = config.route.length; i < length; i++) {
                    var current = system.extend({}, config);

                    current.route = config.route[i];
                    current.isActive = isActive;

                    if (i > 0) {
                        delete current.nav;
                    }

                    configureRoute(current);
                }
            } else {
                configureRoute(config);
            }

            return router;
        }


        /**
         * Maps route patterns to modules.
         * @method map
         * @param {string|object|object[]} route A route, config or array of configs.
         * @param {object} [config] The config for the specified route.
         * @chainable
         * @example
         router.map([
         { route: '', title:'Home', moduleId: 'homeScreen', nav: true },
         { route: 'customer/:id', moduleId: 'customerDetails'}
         ]);
         */
        router.map = function (route, config) {
            if (system.isArray(route)) {
                for (var i = 0; i < route.length; i++) {
                    router.map(route[i]);
                }

                return router;
            }

            if (system.isString(route) || system.isRegExp(route)) {
                if (!config) {
                    config = {};
                } else if (system.isString(config)) {
                    config = { moduleId: config };
                }

                config.route = route;
            } else {
                config = route;
            }

            return mapRoute(config);
        };


        /**
         * Builds an observable array designed to bind a navigation UI to. The model will exist in the `navigationModel` property.
         * @method buildNavigationModel
         * @param {number} defaultOrder The default order to use for navigation visible routes that don't specify an order. The default is 100 and each successive route will be one more than that.
         * @chainable
         */
        router.buildNavigationModel = function (defaultOrder) {
            var nav = [], routes = router.routes, routesIds = {};
            var fallbackOrder = defaultOrder || 100;


            for (var i = 0; i < routes.length; i++) {
                var current = routes[i];

                var id = current.id || current.route;
                if (!routesIds.hasOwnProperty(id))
                    routesIds[id] = i;


                if (current.nav) {
                    if (!system.isNumber(current.nav)) {
                        current.nav = ++fallbackOrder;
                    }

                    nav.push(current);
                }
            }

            nav.sort(function (a, b) { return a.nav - b.nav; });
            router.navigationModel(nav);
            router.routesIds(routesIds);

            return router;
        };

        router.mapInlineView = function (route, viewMarkup) {
            route = route || '';
            viewMarkup = viewMarkup || '<div></div>';

            router.map(route, {
                module: {
                    getView: function () {
                        return viewEngine.processMarkup(viewMarkup);
                    },
                    canReuseForRoute: function () {
                        return true;
                    }
                },
                nav: false
            });

            return router;
        };

        /**
         * Configures how the router will handle unknown routes.
         * @method mapUnknownRoutes
         * @param {string|function} [config] If not supplied, then the router will map routes to modules with the same name.
         * If a string is supplied, it represents the module id to route all unknown routes to.
         * Finally, if config is a function, it will be called back with the route instruction containing the route info. The function can then modify the instruction by adding a moduleId and the router will take over from there.
         * @param {string} [replaceRoute] If config is a module id, then you can optionally provide a route to replace the url with.
         * @chainable
         */
        router.mapUnknownRoutes = function (config, replaceRoute) {
            var catchAllRoute = "*catchall";
            var catchAllPattern = new RouteInfo(catchAllRoute);

            router.route(catchAllPattern, function (fragment) {
                var resConfig = {
                    route: catchAllRoute,
                    routePattern: catchAllPattern
                };

                if (!config) {
                    resConfig.moduleId = fragment;
                } else if (system.isString(config)) {
                    resConfig.moduleId = config;
                    if (replaceRoute) {
                        rootRouter.navigate(replaceRoute, { trigger: false, replace: true });
                    }
                } else if (system.isFunction(config)) {
                    resConfig.initialize = function (instruction) {
                        return toPromise(config(instruction))
                            .then(function () {
                                router.trigger('router:route:before-config', resConfig, router);
                                router.trigger('router:route:after-config', resConfig, router);
                                return instruction;
                            });
                    };
                    return resConfig;
                } else {
                    resConfig = config;
                    resConfig.route = catchAllRoute;
                    resConfig.routePattern = catchAllPattern;
                }

                router.trigger('router:route:before-config', resConfig, router);
                router.trigger('router:route:after-config', resConfig, router);
                return resConfig;
            });

            return router;
        };


        /**
         * Makes all configured routes and/or module ids relative to a certain base url.
         * @method makeRelative
         * @param {string|object} settings If string, the value is used as the base for routes and module ids. If an object, you can specify `route` and `moduleId` separately. In place of specifying route, you can set `fromParent:true` to make routes automatically relative to the parent router's active route.
         * @chainable
         */
        router.makeRelative = function (settings) {
            if (system.isString(settings)) {
                settings = {
                    moduleId: settings,
                    route: settings
                };
            }

            if (settings.moduleId && !endsWith(settings.moduleId, '/')) {
                settings.moduleId += '/';
            }

            if (settings.route && !endsWith(settings.route, '/')) {
                settings.route += '/';
            }

            router.fromParent = settings.fromParent;

            router.on('router:route:before-config').then(function (config) {
                if (settings.moduleId) {
                    config.moduleId = settings.moduleId + config.moduleId;
                }

                if (settings.route) {
                    if (config.route === '') {
                        config.route = settings.route.substring(0, settings.route.length - 1);
                    } else {
                        config.route = settings.route + config.route;
                    }
                }
            });

            return router;
        };


        /**
         * Parses a query string into an object.
         * @method parseQueryString
         * @param {string} queryString The query string to parse.
         * @return {object} An object keyed according to the query string parameters.
         */
        router.parseQueryString = function (queryString) {
            var queryObject, pairs;

            if (!queryString) {
                return null;
            }

            pairs = queryString.split('&');

            if (pairs.length == 0) {
                return null;
            }

            queryObject = {};

            for (var i = 0; i < pairs.length; i++) {
                var pair = pairs[i];
                if (pair === '') {
                    continue;
                }

                var parts = pair.split(/=(.+)?/),
                    key = parts[0],
                    value = parts[1] && decodeURIComponent(parts[1].replace(/\+/g, ' '));

                var existing = queryObject[key];

                if (existing) {
                    if (system.isArray(existing)) {
                        existing.push(value);
                    } else {
                        queryObject[key] = [existing, value];
                    }
                }
                else {
                    queryObject[key] = value;
                }
            }

            return queryObject;
        };


        // --------------------------------- Override-able Conventional Api --------------------------------------------

        /**
         * Tells whether a token found inside a route's authorize property has permission to execute.
         */
        router.permissions = ko.observableArray([]);
        router.hasPermission = function (token, instruction) {
            return router.permissions.indexOf(token) != -1 ||
                (router.parent && router.parent.hasPermission(token, instruction));
        };

        /**
         * Converts a route to a module id. This is only called if no module id is supplied as part of the route mapping.
         * @method convertRouteToModuleId
         * @param {string} route
         * @return {string} The module id.
         */
        router.convertRouteToModuleId = function (route) {
            return stripParametersFromRoute(route);
        };


        /**
         * Converts a route to a displayable title. This is only called if no title is specified as part of the route mapping.
         * @method convertRouteToTitle
         * @param {string} route
         * @return {string} The title.
         */
        router.convertRouteToTitle = function (route) {
            var value = stripParametersFromRoute(route);
            return value.substring(0, 1).toUpperCase() + value.substring(1);
        };


        /**
         * Updates the document title based on the activated module instance, the routing instruction and the app.title.
         * @method updateDocumentTitle
         * @param {object} instance The activated module.
         * @param {object} instruction The routing instruction associated with the action. It has a `config` property that references the original route mapping config.
         */
        router.updateDocumentTitle = function (instance, instruction) {
            var appTitle = ko.unwrap(app.title),
                title = instruction.config.title;

            if (titleSubscription) {
                titleSubscription.dispose();
            }

            if (title) {
                if (ko.isObservable(title)) {
                    titleSubscription = title.subscribe(setTitle);
                    setTitle(title());
                } else {
                    setTitle(title);
                }
            } else if (appTitle) {
                document.title = appTitle;
            }
        };
        var titleSubscription;


        function setTitle(value) {
            var appTitle = ko.unwrap(app.title);

            if (appTitle) {
                document.title = value + " | " + appTitle;
            } else {
                document.title = value;
            }
        }

        // Allow observable to be used for app.title
        if (ko.isObservable(app.title)) {
            app.title.subscribe(function () {
                var instruction = router.activeInstruction();
                var title = instruction != null ? ko.unwrap(instruction.config.title) : '';
                setTitle(title);
            });
        }


        // ------------------------------------------ Navigation Api ---------------------------------------------------

        /**
         * Save a fragment into the hash history, or replace the URL state if the
         * 'replace' option is passed. You are responsible for properly URL-encoding
         * the fragment in advance.
         * The options object can contain `trigger: false` if you wish to not have the
         * route callback be fired, or `replace: true`, if
         * you wish to modify the current URL without adding an entry to the history.
         * @method navigate
         * @param {string} fragment The url fragment to navigate to.
         * @param {object|boolean} options An options object with optional trigger and replace flags. You can also pass a boolean directly to set the trigger option. Trigger is `true` by default.
         * @return {boolean} Returns true/false from loading the url.
         */
        router.navigate = function (fragment, options) {
            if (fragment && fragment.indexOf('://') != -1) {
                window.location.href = fragment;
                return true;
            }

            var curInst = currentInstruction || router.activeInstruction();

            var qsIndex = fragment ? fragment.indexOf('?') : -1,
                qs = qsIndex>=0 ? fragment.substring(qsIndex) : (curInst.queryString ? '?' + curInst.queryString : '');

            // make fragment absolute to rootRouter
            fragment = curInst.routeFragment
                .reduce(fragment)
                .replace(/(^\/*)|(\/*$)/g, '') + qs;

            // calls through api doesn't change url until navigation is going to activate.
            // also we don't set rootRouter.explicitNavigation here, because it can affect other navigations currently in progress
            return rootRouter.loadUrl(fragment, options);
        };


        /**
         * Navigates back in the browser history.
         * @method navigateBack
         */
        router.navigateBack = function () {
            history.navigateBack();
        };


        router.navigateUp = function () {
            var curInstruction = currentInstruction || router.activeInstruction();
            var curConfig = curInstruction && curInstruction.config;
            return (curConfig && curConfig.parent)
                ? router.navigate(curConfig.parent)
                : router.navigate('');
        };


        var currentRouteId = ko.observable(undefined),
            lastBreadcrumb = [];
        router.breadcrumb = ko.computed({
            read: function () {
                if (router.deactivated) return lastBreadcrumb;

                var routeId = currentRouteId();
                if (routeId === undefined) return lastBreadcrumb;

                var item = activeItem();
                if (!item) return lastBreadcrumb;

                var routes = router.routes,
                    routesIds = router.routesIds(),
                    res = [];

                for (var j = routesIds[routeId]; typeof j == 'number'; j = routesIds[routes[j].parent])
                    res.unshift(routes[j]);

                var childRouter = hasChildRouter(item);
                if (childRouter) res.push.apply(res, childRouter.breadcrumb().slice(1));

                return lastBreadcrumb = res;
            },
            deferEvaluation: true
        });


        // =============================================== Child Routers ===============================================

        /**
         * Returns the current context router. It may be called in the process of activation life-cycle.
         * @method getContextRouter
         * @param {string} depth optionally a depth parameter can be passed to some level deeper. 0 is current context router.
         * @return {Router} The context router.
         */
        router.getContextRouter = function (depth) {
            if (contextRouter.length == 0)
                throw new Error('No context router is available. Context router is only available in activation life-cycle calls.');

            depth = depth || 0;
            if (depth > contextRouter.length)
                throw new Error('No context router is available in the specified depth.');

            return contextRouter[contextRouter.length - depth - 1];
        };


        /**
         * Creates a child router, parent router is the one activating current module (context router). Context router is only available in module resolution and activation life-cycle calls.
         * @method createChildRouter
         * @param {string} parent router, if not specified context router will be used.
         * @return {Router} The child router.
         */
        router.createChildRouter = function (parent) {
            var childRouter = createRouter();
            childRouter.parent = parent || (contextRouter.length > 0 && contextRouter[contextRouter.length - 1]) || router;
            return childRouter;
        };


        /**
         * Resets the router by removing handlers, routes, event handlers and previously configured options.
         * @method reset
         * @chainable
         */
        router.reset = function () {
            currentInstruction = currentActivation = undefined;
            router.handlers = [];
            router.routes = [];
            router.off();
            delete router.options;
            return router;
        };

        return router;
    };


    // ================================================== Root Router ==================================================

    var lastUrl, currentUrl;


    /**
     * @class RouterModule
     * @extends Router
     * @static
     */
    rootRouter = createRouter();


    /**
     * Attempt to load the specified URL fragment. If a route succeeds with a match, and navigation succeeds to completion resolves to `true`. If no defined routes matches the fragment or navigation is canceled for whatever reason, resolves to `false`.
     * @method loadUrl
     * @param {string} fragment The URL fragment to find a match for. If not specified, current url is tried to be reloaded.
     * @return {promise} Resolves to true when navigation completes, or false if navigation is canceled.
     */
    rootRouter.loadUrl = function (fragment, options) {
        if (system.isObject(fragment)) {
            options = fragment;
            fragment = currentUrl;
        }
        if (fragment === undefined) fragment = currentUrl;

        var apiNavigation = options === undefined || (system.isObject(options) && (options.apiNavigation === undefined || !!options.apiNavigation));
        var clickNavigation = system.isObject(options) && !!options.clickNavigation;
        options = extendNavigationOptions(options);

        if (!options.trigger) {
            currentUrl = fragment;
            if (options.replace) lastUrl = fragment;
            return history.navigate(fragment, options);
        }


        var loadedCurrentUrl = currentUrl;
        var loadedLastUrl = lastUrl;

        return rootRouter.loadFragment(fragment)
            .then(function (canContinue) {
                // if fragment is not the same as active url when trigger is called, it means trigger has been called by api
                rootRouter.navigatingBack = !clickNavigation && !apiNavigation;
                rootRouter.explicitNavigation = clickNavigation || apiNavigation;

                if (!canContinue) {
                    // even if navigation is canceled, we don't wanna mess url of other navigations in queue
                    if (fragment == currentUrl && currentUrl == loadedCurrentUrl) {
                        history.navigate(lastUrl, { trigger: false, replace: rootRouter.explicitNavigation });
                        currentUrl = lastUrl;
                    }
                    return false;
                }

                return canContinue()
                    .then(function (activatedInstance) {
                        if (apiNavigation && (lastUrl == loadedLastUrl || currentUrl == loadedCurrentUrl)) {
                            history.navigate(fragment, { trigger: false, replace: options.replace });
                            currentUrl = fragment;
                        }
                        lastUrl = fragment;

                        return activatedInstance;
                    });
            })
            .then(function (res) {
                if (startDeferred) {
                    startDeferred.resolve();
                    startDeferred = null;
                }
                rootRouter.navigatingBack = undefined;
                rootRouter.explicitNavigation = undefined;
                return res;
            });
    };


    /**
     * Makes the RegExp generated for routes case sensitive, rather than the default of case insensitive.
     * @method makeRoutesCaseSensitive
     */
    rootRouter.makeRoutesCaseSensitive = function () {
        routesAreCaseSensitive = true;
    };


    /**
     * Verify that the target is the current window
     * @method targetIsThisWindow
     * @return {boolean} True if the event's target is the current window, false otherwise.
     */
    rootRouter.targetIsThisWindow = function (event) {
        var targetWindow = $(event.target).attr('target');

        return  !targetWindow ||
            targetWindow === window.name ||
            targetWindow === '_self' ||
            (targetWindow === 'top' && window === window.top)
    };


    /**
     * Activates the router and the underlying history tracking mechanism.
     * @method activate
     * @return {Promise} A promise that resolves when the router is ready.
     */
    rootRouter.activate = function (options) {

        var clickNavigation = false;

        function loadUrl(fragment) {
            currentUrl = fragment;
            var isClick = clickNavigation;
            clickNavigation = false;

            return rootRouter.loadUrl(fragment, {
                trigger: true,
                clickNavigation: isClick
            });
        }


        return system.defer(function (dfd) {
            startDeferred = dfd;
            rootRouter.options = system.extend({ routeHandler: loadUrl }, rootRouter.options, options);

            history.activate(rootRouter.options);

            if (history._hasPushState) {
                var routes = rootRouter.routes,
                    i = routes.length;

                while (i--) {
                    var current = routes[i];
                    current.hash = current.hash.replace('#', '/');
                }
            }

            var rootStripper = rootRouter.options.root && new RegExp("^" + rootRouter.options.root + "/");

            $(document).delegate("a", 'click', function (evt) {
                if (history._hasPushState) {
                    if (!evt.altKey && !evt.ctrlKey && !evt.metaKey && !evt.shiftKey && rootRouter.targetIsThisWindow(evt)) {
                        var href = $(this).attr("href");

                        // Ensure the protocol is not part of URL, meaning its relative.
                        // Stop the event bubbling to ensure the link will not cause a page refresh.
                        if (href != null && !(href.charAt(0) === "#" || /^[a-z]+:/i.test(href))) {
                            clickNavigation = true;
                            evt.preventDefault();

                            if (rootStripper) {
                                href = href.replace(rootStripper, "");
                            }

                            history.navigate(href);
                        }
                    }
                } else {
                    clickNavigation = true;
                }
            });

            if (history.options.silent && startDeferred) {
                startDeferred.resolve();
                startDeferred = null;
            }
        }).promise();
    };

    /**
     * Disable history, perhaps temporarily. Not useful in a real app, but possibly useful for unit testing Routers.
     * @method deactivate
     */
    rootRouter.deactivate = function () {
        history.deactivate();
    };

    /**
     * Installs the router's custom ko binding handler.
     * @method install
     */
    rootRouter.install = function () {
        ko.bindingHandlers.router = {
            init: function () {
                return { controlsDescendantBindings: true };
            },
            update: function (element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
                var settings = ko.utils.unwrapObservable(valueAccessor()) || {};

                if (settings.__router__) {
                    settings = {
                        model: settings.activeItem(),
                        attached: settings.attached,
                        compositionComplete: settings.compositionComplete,
                        activate: false
                    };
                } else {
                    var theRouter = ko.utils.unwrapObservable(settings.router || viewModel.router) || rootRouter;
                    settings.model = theRouter.activeItem();
                    settings.attached = theRouter.attached;
                    settings.compositionComplete = theRouter.compositionComplete;
                    settings.activate = false;
                }

                composition.compose(element, settings, bindingContext);
            }
        };

        ko.virtualElements.allowedBindings.router = true;
    };

    return rootRouter;
});
