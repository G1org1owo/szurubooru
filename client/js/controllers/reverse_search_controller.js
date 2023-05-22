"use strict";

const api = require("../api.js");
const progress = require("../util/progress.js");
const topNavigation = require("../models/top_navigation.js");
const Post = require("../models/post.js");
const ReverseSearchView = require("../views/reverse_search_view.js");
const EmptyView = require("../views/empty_view.js");

class ReverseSearchController {
    constructor(ctx) {
        this._ctx = ctx;

        if (!api.hasPrivilege("posts:reverseSearch")) {
            this._view = new EmptyView();
            this._view.showError("You don't have privileges to reverse search posts.");
            return;
        }

        topNavigation.activate("reverse_search");
        topNavigation.setTitle("Reverse Search");
        this._view = new ReverseSearchView(this._ctx);
        this._view.addEventListener("submit", (e) => this._evtSubmit(e));
    }

    _evtSubmit(e) {
        this._view.clearMessages();

        this._reverseSearchPost(
            e.detail.uploadable
        );
    }

    _reverseSearchPost(uploadable) {
        progress.start();
        let reverseSearchPromise = this._ctx.parameters.id ?
            Post.reverseSearchById(this._ctx.parameters.id) :
            Post.reverseSearch(
            uploadable.url || uploadable.file
        );

        return reverseSearchPromise
            .then((searchResult) => {
                this._view.showResults(searchResult);
            })
            .then(
                (result) => {
                    progress.done();
                    return Promise.resolve(result);
                },
                (error) => {
                    error.uploadable = uploadable;
                    progress.done();
                    return Promise.reject(error);
                }
            );
    }
}

module.exports = (router) => {
    router.enter(["reverse-search"], (ctx, next) => {
        ctx.controller = new ReverseSearchController(ctx);
    });

    router.enter(["reverse-search", ":id"], (ctx, next) => {
       ctx.controller = new ReverseSearchController(ctx)
    });
};
