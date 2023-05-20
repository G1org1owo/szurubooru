"use strict";

const events = require("../events.js");
const api = require("../api.js");
const views = require("../util/views.js");
const FileDropperControl = require("../controls/file_dropper_control.js");
const settings = require("../models/settings");
const uri = require("../util/uri");
const PageController = require("../controllers/page_controller.js");
const PostList = require("../models/post_list");
const PostsPageView = require("./posts_page_view");

const template = views.getTemplate("post-upload");

function _mimeTypeToPostType(mimeType) {
    return (
        {
            "application/x-shockwave-flash": "flash",
            "image/gif": "image",
            "image/jpeg": "image",
            "image/png": "image",
            "image/webp": "image",
            "image/bmp": "image",
            "image/avif": "image",
            "image/heif": "image",
            "image/heic": "image",
            "video/mp4": "video",
            "video/webm": "video",
        }[mimeType] || "unknown"
    );
}

class Uploadable extends events.EventTarget {
    constructor() {
        super();
        this.lookalikes = [];
        this.lookalikesConfirmed = false;
        this.safety = "safe";
        this.flags = [];
        this.tags = [];
        this.relations = [];
        this.anonymous = !api.isLoggedIn();
    }

    destroy() {}

    get mimeType() {
        return "application/octet-stream";
    }

    get type() {
        return _mimeTypeToPostType(this.mimeType);
    }

    get key() {
        throw new Error("Not implemented");
    }

    get name() {
        throw new Error("Not implemented");
    }
}

class File extends Uploadable {
    constructor(file) {
        super();
        this.file = file;

        this._previewUrl = null;
        if (URL && URL.createObjectURL) {
            this._previewUrl = URL.createObjectURL(file);
        } else {
            let reader = new FileReader();
            reader.readAsDataURL(file);
            reader.addEventListener("load", (e) => {
                this._previewUrl = e.target.result;
                this.dispatchEvent(
                    new CustomEvent("finish", { detail: { uploadable: this } })
                );
            });
        }
    }

    destroy() {
        if (URL && URL.createObjectURL && URL.revokeObjectURL) {
            URL.revokeObjectURL(this._previewUrl);
        }
    }

    get mimeType() {
        return this.file.type;
    }

    get previewUrl() {
        return this._previewUrl;
    }

    get key() {
        return this.file.name + this.file.size;
    }

    get name() {
        return this.file.name;
    }
}

class Url extends Uploadable {
    constructor(url) {
        super();
        this.url = url;
        this.dispatchEvent(new CustomEvent("finish"));
    }

    get mimeType() {
        let mime = {
            swf: "application/x-shockwave-flash",
            jpg: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            webp: "image/webp",
            bmp: "image/bmp",
            avif: "image/avif",
            heif: "image/heif",
            heic: "image/heic",
            mp4: "video/mp4",
            webm: "video/webm",
        };
        for (let extension of Object.keys(mime)) {
            if (this.url.toLowerCase().indexOf("." + extension) !== -1) {
                return mime[extension];
            }
        }
        return "unknown";
    }

    get previewUrl() {
        return this.url;
    }

    get key() {
        return this.url;
    }

    get name() {
        return this.url;
    }
}

class ReverseSearchView extends events.EventTarget {
    constructor(ctx) {
        super();

        this._ctx = ctx;
        this._pageController = new PageController();
        this._hostNode = this._pageController.view.pageHeaderHolderNode;

        views.replaceContent(this._hostNode, template());
        views.syncScrollPosition();

        this._cancelButtonNode.disabled = true;
        this._uploadable = undefined;

        this._contentFileDropper = new FileDropperControl(
            this._contentInputNode,
            {
                extraText:
                    "Allowed extensions: .jpg, .png, .gif, .webm, .mp4, .swf, .avif, .heif, .heic",
                allowUrls: true,
                allowMultiple: true,
                lock: false,
            }
        );
        this._contentFileDropper.addEventListener("fileadd", (e) =>
            this._evtFilesAdded(e)
        );
        this._contentFileDropper.addEventListener("urladd", (e) =>
            this._evtUrlsAdded(e)
        );

        this._formNode.classList.add("inactive");
    }

    enableForm() {
        views.enableForm(this._formNode);
        this._cancelButtonNode.disabled = true;
        this._formNode.classList.remove("uploading");
    }

    disableForm() {
        views.disableForm(this._formNode);
        this._cancelButtonNode.disabled = false;
        this._formNode.classList.add("uploading");
    }

    clearMessages() {
        views.clearMessages(this._hostNode);
    }

    showResults(searchResult){
        this._pageController.run({
            parameters: this._ctx.parameters,
            defaultLimit: parseInt(settings.get().postsPerPage),
            getClientUrlForPage: (offset, limit) => {
                const parameters = Object.assign({}, this._ctx.parameters, {
                    offset: offset,
                    limit: limit,
                });
                return uri.formatClientLink("posts", parameters);
            },
            requestPage: (offset, limit) => {
                return Promise.resolve(
                    Object.assign({}, searchResult, {
                        results: PostList.fromResponse(searchResult.similarPosts.slice(offset, limit).map(result => result.post))
                    }
                ));
            },
            pageRenderer: (pageCtx) => {
                Object.assign(pageCtx, {
                    canViewPosts: api.hasPrivilege("posts:view"),
                    canBulkEditTags: api.hasPrivilege("posts:bulk-edit:tags"),
                    canBulkEditSafety: api.hasPrivilege(
                        "posts:bulk-edit:safety"
                    ),
                    canBulkDelete: api.hasPrivilege("posts:bulk-edit:delete"),
                    bulkEdit: {
                        tags: this._bulkEditTags,
                        markedForDeletion: this._postsMarkedForDeletion,
                    },
                    postFlow: settings.get().postFlow,
                });

                const view = new PostsPageView(pageCtx);
                view.addEventListener("tag", (e) => this._evtTag(e));
                view.addEventListener("untag", (e) => this._evtUntag(e));
                view.addEventListener("changeSafety", (e) =>
                    this._evtChangeSafety(e)
                );
                view.addEventListener("markForDeletion", (e) =>
                    this._evtMarkForDeletion(e)
                );
                return view;
            }
        });
    }

    showSuccess(message) {
        views.showSuccess(this._hostNode, message);
    }

    showError(message, uploadable) {
        this._showMessage(views.showError, message, uploadable);
    }

    showInfo(message, uploadable) {
        this._showMessage(views.showInfo, message, uploadable);
        views.appendExclamationMark();
    }

    _showMessage(functor, message, uploadable) {
        functor(uploadable ? uploadable.rowNode : this._hostNode, message);
    }

    addUploadables(uploadable) {
        this._uploadable = uploadable;
        this._emit("submit");
    }

    _evtFilesAdded(e) {
        this.addUploadables(e.detail.files.map((file) => new File(file))[0]);
    }

    _evtUrlsAdded(e) {
        this.addUploadables(e.detail.urls.map((url) => new Url(url))[0]);
    }

    /*_updateUploadableFromDom(uploadable) {
        const rowNode = uploadable.rowNode;

        const safetyNode = rowNode.querySelector(".safety input:checked");
        if (safetyNode) {
            uploadable.safety = safetyNode.value;
        }

        const anonymousNode = rowNode.querySelector(
            ".anonymous input:checked"
        );
        if (anonymousNode) {
            uploadable.anonymous = true;
        }

        uploadable.tags = [];
        uploadable.relations = [];
        for (let [i, lookalike] of uploadable.lookalikes.entries()) {
            let lookalikeNode = rowNode.querySelector(
                `.lookalikes li:nth-child(${i + 1})`
            );
            if (lookalikeNode.querySelector("[name=copy-tags]").checked) {
                uploadable.tags = uploadable.tags.concat(
                    lookalike.post.tagNames
                );
            }
            if (lookalikeNode.querySelector("[name=add-relation]").checked) {
                uploadable.relations.push(lookalike.post.id);
            }
        }
    }*/

    /*_evtRemoveClick(e, uploadable) {
        e.preventDefault();
        if (this._uploading) {
            return;
        }
        this.removeUploadable(uploadable);
    }

    _evtMoveClick(e, uploadable, delta) {
        e.preventDefault();
        if (this._uploading) {
            return;
        }
        let index = this._uploadables.find(uploadable);
        if ((index + delta).between(-1, this._uploadables.length)) {
            let uploadable1 = this._uploadables[index];
            let uploadable2 = this._uploadables[index + delta];
            this._uploadables[index] = uploadable2;
            this._uploadables[index + delta] = uploadable1;
            if (delta === 1) {
                this._listNode.insertBefore(
                    uploadable2.rowNode,
                    uploadable1.rowNode
                );
            } else {
                this._listNode.insertBefore(
                    uploadable1.rowNode,
                    uploadable2.rowNode
                );
            }
        }
    }*/

    _emit(eventType) {
        this.dispatchEvent(
            new CustomEvent(eventType, {
                detail: {
                    uploadable: this._uploadable
                }
            })
        );
    }

    /*_renderRowNode(uploadable) {
        const rowNode = rowTemplate(
            Object.assign({}, this._ctx, { uploadable: uploadable })
        );
        if (uploadable.rowNode) {
            uploadable.rowNode.parentNode.replaceChild(
                rowNode,
                uploadable.rowNode
            );
        } else {
            this._listNode.appendChild(rowNode);
        }

        uploadable.rowNode = rowNode;

        rowNode
            .querySelector("a.remove")
            .addEventListener("click", (e) =>
                this._evtRemoveClick(e, uploadable)
            );
        rowNode
            .querySelector("a.move-up")
            .addEventListener("click", (e) =>
                this._evtMoveClick(e, uploadable, -1)
            );
        rowNode
            .querySelector("a.move-down")
            .addEventListener("click", (e) =>
                this._evtMoveClick(e, uploadable, 1)
            );
    }

    _updateThumbnailNode(uploadable) {
        const rowNode = rowTemplate(
            Object.assign({}, this._ctx, { uploadable: uploadable })
        );
        views.replaceContent(
            uploadable.rowNode.querySelector(".thumbnail"),
            rowNode.querySelector(".thumbnail").childNodes
        );
    }*/

    get _uploading() {
        return this._formNode.classList.contains("uploading");
    }

    get _listNode() {
        return this._hostNode.querySelector(".uploadables-container");
    }

    get _formNode() {
        return this._hostNode.querySelector("form");
    }

    get _submitButtonNode() {
        return this._hostNode.querySelector("form [type=submit]");
    }

    get _cancelButtonNode() {
        return this._hostNode.querySelector("form .cancel");
    }

    get _contentInputNode() {
        return this._formNode.querySelector(".dropper-container");
    }
}

module.exports = ReverseSearchView;
