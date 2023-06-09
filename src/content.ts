/**
 * The Content script runs in each Chrome tab, it is responsible for:
 *  - connecting to the background script and routing events to/from it
 *  - injecting the fdc3 api into each tab
 *  - rendering the intent resolver UI
 *  
 */
import utils from "./utils";
import {FDC3Event} from './types/FDC3Event';
import {FDC3Message} from './types/FDC3Message';
import {AppInstance, InstanceTypeEnum} from './types/AppInstance';
import {IntentInstance} from './types/IntentInstance';
import { FDC3App } from "./types/FDC3Data";


//establish comms with the background script 
const port = chrome.runtime.connect({name: "fdc3"});

//flag to indicate the background script is ready for fdc3!
let connected = false;

//queue of pending events - accumulate until the background is ready
const eventQ : Array<FDC3Message> = [];


/**
 * return listeners
 * most fdc3 api calls are promise based and many require resolution/rejection following complex interaction that may involve end user input, app loading times etc
 * so, we need to a symetrical return event when events are dispatched to the background script and to uniquely identifiy the event
 * also, need to support timeout/expiration of the event, for example, if an app takes too long to load or an end user never responds to a prompt
 * 
 * all promise based FDC3 methods send an event to the background script and listens for an event of "return" + eventName 
 * a unique identifier is assigned to the event (timestamp) 
 * the return handler will route back to correct handler function via the timestamp identifier
 * handlers will be routinely cleaned up by finding all events that have expired (check timestamp) and rejecting those items
 */
//collection of listeners for api calls coming back from the background script
const returnListeners : Map<string, any> = new Map();
const returnTimeout = (1000 * 60 * 2);

 //listen for return messages for api calls
 port.onMessage.addListener(msg => {
    //is there a returnlistener registered for the event?
    const listener = returnListeners.has(msg.topic) ? returnListeners.get(msg.topic).listener : null;
    if (listener){
        listener.call(port,msg);
        returnListeners.delete(msg.name);
    }
 });

 //automated handlers based on manifest metadata - other handlers are set and dispatched by the API layer
 //these just need to be markers - since the handling itself is just autogenerated from the metadata held in the manifest 
const _intentHandlers : Array<string> = []; 
const  _contextHandlers : Array<string> = [];
let contentName : string = null;
let currentChannel : string = null;

 //retrieve the document title for a tab
const getTabTitle = (tabId : number) : Promise<string> => {
    let id = tabId;
    return new Promise((resolve, reject) => {
        port.onMessage.addListener(msg => {
            if (msg.topic === "tabTitle" && id === msg.tabId){
                resolve(msg.data.title);
            }
        });
        port.postMessage({topic:"getTabTitle", "tabId":tabId});
    });  
};


const wireTopic = (topic : string, config?: any) : void => {
    
    document.addEventListener(`FDC3:${topic}`,(e : FDC3Event) => {
        const cb = config ? config.cb : null;
        const isVoid = config ? config.isVoid : null;

        //get eventId and timestamp from the event 
        if (! isVoid){
            const eventId : string = e.detail !== null ? e.detail.eventId : null;
            
            if (eventId !== null){
                returnListeners.set(eventId, {
                    ts:e.ts,
                    listener:function(msg : FDC3Message, port : chrome.runtime.Port){
                    document.dispatchEvent(utils.fdc3Event(`return_${eventId}`, msg.data)); }
                });
            }
            if (cb){
                cb.call(this,e);
            }
        }
        //if  background script isn't ready yet, queue these messages...
        const msg : FDC3Message = {topic:topic,  data:e.detail};
        if (!connected){
            eventQ.push(msg);
        }
        else {
            port.postMessage(msg);   
        }
    }); 
    
};
 
 //listen for FDC3 events
 const topics = ["open","raiseIntent","raiseIntentForContext","addContextListener","addIntentListener","findIntent","findIntentsByContext","getCurrentContext","getSystemChannels","getOrCreateChannel", "getCurrentChannel", "getAppInstance"];
 topics.forEach(t => {wireTopic(t);});
 //set the custom ones...
 wireTopic("joinChannel",{cb:(e : FDC3Event) => { currentChannel = e.detail.channel;}});
 wireTopic("leaveCurrentChannel",{cb:(e : FDC3Event) => { currentChannel = "default";}});
 wireTopic("broadcast",{isVoid:true});
 wireTopic("dropContextListener",{isVoid:true});
 wireTopic("dropIntentListener",{isVoid:true});

document.addEventListener("FDC3:resolver-close", e => {
    port.postMessage({topic:"resolver-close"});   
    if (resolver){
        resolver.style.display = "none";
    }
});





port.onMessage.addListener(async (msg) => {
     
    
    if (msg.topic === "environmentData"){
        console.log("app connected", msg.data, eventQ);
        //we're now ready for general fdc3 comms with the background
        connected = true;
        //if there is a queue of pending events, then act on them, these will mostly be addContext/addIntent Listener calls
        eventQ.forEach(e => {
            port.postMessage(e); 
        });

        contentName = msg.data.directory ? msg.data.directory.name : null;
        

        if (msg.data.currentChannel){
            console.log("content - joinChannel", msg.data.currentChannel);
            currentChannel = msg.data.currentChannel;
            //re-join the channel but don't get the current context - since we are reloading or navigating 
            port.postMessage({topic:"joinChannel", "data": {channel:currentChannel, restoreOnly:true}});      
        }
    }
   else  if (msg.topic === "context"){
       //check for handlers at the content script layer (automatic handlers) - if not, dispatch to the API layer...
       let contextSent = false;
       if (msg.data && msg.data.context){
       
            if (!contextSent) {   
                document.dispatchEvent(new CustomEvent("FDC3:context",{
                    detail:{data:msg.data, source:msg.source }
                }));
            }
        }

       
    }
    else if (msg.topic === "intent") {
        let intentSent = false;

        if (!intentSent){
            document.dispatchEvent(new CustomEvent("FDC3:intent",{
                detail:{data:msg.data, source:msg.source}
            })); 
        }
    }
    else if (msg.topic === "setCurrentChannel"){
        if (msg.data.channel){
            currentChannel = msg.data.channel;
        }
    }

});

let resolver : HTMLElement = null;

 document.addEventListener('keydown', k => {
     if (k.code === "Escape" ){
        document.dispatchEvent(new CustomEvent("FDC3:resolver-close",{
        })); 
       /* if (resolver){
            resolver.style.display = "none";
        }*/
    }
});

/**
 * generate app item row for resolver UI
 * - title of app
 *  - exact title for live instance
 * - indicator if live or directory
 * - icon
 * - handler to launch (with context & intent)
 * 
 */
const createAppRow = (item : FDC3App, list : Element, eventId : string, intent : string, context : any) : void => {
    const selected = item;
    const tab : chrome.tabs.Tab = item.details && item.details.port ? item.details.port.sender.tab : null;
    const data = item.details.directoryData ? item.details.directoryData : null;
    const rItem : Element = document.createElement("div");

    rItem.className = "item";
    const title = data ? data.title : "Untitled";
    const iconContainer  = document.createElement("span");
    iconContainer.className = "icon-container";
    //place a 'new window' icon?
    if (item.type === InstanceTypeEnum.Directory){
        const newIcon : HTMLElement = document.createElement("img");
        newIcon.className = "icon new";
      //  newIcon.title = "New Instance";
        iconContainer.appendChild(newIcon);
    }
    const iconNode : Element = document.createElement("img");
    iconNode.className = "icon";
    iconContainer.appendChild(iconNode);
    rItem.appendChild(iconContainer);
    const titleNode : Element = document.createElement("span");
    rItem.appendChild(titleNode);
    //title should reflect if this is creating a new window, or loading to an existing one
    if (item.type === InstanceTypeEnum.Window){
        
    // let icon = document.createElement("img");
    // icon.className = "icon"; 
        if (tab.favIconUrl){
            iconNode.setAttribute("src", tab.favIconUrl);
        }
        //rItem.appendChild(icon);
        //titleNode = document.createElement("span");
        titleNode.id = "title-" + tab.id;
        titleNode.textContent = title;
        titleNode.setAttribute("title", `${title} (${tab.url})`);
        const query : string = "#title-" + tab.id;
        
        //async get the window title
        getTabTitle(tab.id).then((t : string )=> { 
            let titles =  list.querySelectorAll(query);
            if (titles.length > 0 && t.length > 0){
                titles[0].textContent = t;
                titles[0].setAttribute("title",`${t} (${tab.url})`);
            }
        });
    }
    else {
        if (data && data.icons && data.icons.length > 0){
            iconNode.setAttribute("src", data.icons[0].icon);
        }
    }
    if (titleNode){
        if (titleNode.textContent.length === 0){
            titleNode.textContent = title;
        }
        if (titleNode.getAttribute("title") === null || titleNode.getAttribute("title").length === 0){
            titleNode.setAttribute("title",(data ? data.start_url : (tab ? tab.title : "Untitled")));
        }
        
    }
    rItem.addEventListener("click",evt => {

        //send resolution message to extension to route
        port.postMessage({
            topic:eventId,
            intent:intent,
            selected:selected,
            context:context
        }); 
        list.innerHTML = "";
        resolver.style.display = "none";
    });

    list.appendChild(rItem);
};
 
 //handle click on extension button
 //raise directory search overlay
 chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
       // console.log("contentScript message",request, sender);
        if (request.message === "get-tab-title"){
            sendResponse(document.title);
        }
        else if (request.message === "popup-get-current-channel"){
            sendResponse(currentChannel);
        }
        else if (request.message === "popup-join-channel"){
            currentChannel = request.channel;
            port.postMessage({topic:"joinChannel", "data": {channel:request.channel}}); 
        }
        else if (request.message === "popup-open"){
            port.postMessage({topic:"open", "data": {name:request.selection.name, start_url: request.selection.start_url, autojoin:true}}); 
        }

        //resolve intents by context
        else if (request.message === "context_resolver"){
            if (! resolver){
                resolver = createResolverRoot();
                document.body.appendChild(resolver);
            }
            resolver.style.display = "block";
            const list = resolver.shadowRoot.querySelectorAll("#resolve-list")[0];
            list.innerHTML = "";
            const header : Element = resolver.shadowRoot.querySelectorAll("#resolve-header .header-text")[0];
            header.textContent = `Resolving Context '${request.context.type}'`;

            request.data.forEach((item : IntentInstance) => {
                const intentRow = document.createElement("div");
                intentRow.className = "intentRow";
                const intentTitle = document.createElement("div");
                intentTitle.className = "intentTitle";
                intentTitle.textContent = item.intent.displayName;
                intentRow.appendChild(intentTitle);
                const appList = document.createElement("div");
                appList.className = "appList";
                item.apps.forEach((app : FDC3App) => {
                    createAppRow(app, appList, request.eventId, item.intent.name, request.context);

                });
                intentRow.appendChild(appList);
                //    <div class='intentTitle'  onClick={ (event: MouseEvent) => this.intentClick(event)}>{item.intent.displayName} </div>
                list.appendChild(intentRow);
            });
        }
        
        //resolve by a single intent
        else if (request.message === "intent_resolver"){
            if (! resolver){
                resolver = createResolverRoot();
                document.body.appendChild(resolver);
            }
            resolver.style.display = "block";
            //resolve the intent name to the display name for the intent - by looking it up in the data response
            let dName : string = null;
            
            request.data.forEach((item : any )=> {
                if (!dName && item.details.directoryData && Array.isArray(item.details.directoryData.intents)){
                    item.details.directoryData.intents.forEach((intent : any) => {
                        if(intent.name === request.intent){
                            dName = intent.display_name;
                        }
                    });
                }
            } );
            const header : Element = resolver.shadowRoot.querySelectorAll("#resolve-header .header-text")[0];
            header.textContent = `Resolving Intent '${(dName ? dName : request.intent)}'`;
            const list = resolver.shadowRoot.querySelectorAll("#resolve-list")[0];
            list.innerHTML = "";

            //contents
            //item represents an app...
            request.data.forEach((item : AppInstance) => {
                createAppRow(item, list, request.eventId, request.intent, request.context);
            });
        }

    }
    
  );

  function createResolverRoot() : HTMLElement{
        
        // Create root element
        const root : HTMLElement= document.createElement('div');
        const wrapper : HTMLElement = document.createElement('div');
        wrapper.id = "fdc3-intent-resolver";

        //cancel any click bubbling, so that a click on the resolver doesn't close it
        root.addEventListener("click",(event : MouseEvent) => {
            event.cancelBubble = true;
            event.stopPropagation();
        });
         // Create a shadow root
         const shadow : ShadowRoot = root.attachShadow({mode: 'open'});

        // Create some CSS to apply to the shadow dom
        const style : Element= document.createElement('style');

        style.textContent = `
        #fdc3-intent-resolver {
            width:400px;
            height:400px;
            margin-left:-200px;
            margin-top:-200px;
            left:50%;
            top:50%;
            background-color:#eee;
            position:absolute;
            z-index:9999;
            font-family:sans-serif;
            filter: drop-shadow(2px 1px 1px #969696);
            border-radius: 10px;
            border:1px solid #fff;
   
        }

        #resolve-header {   
            color:#eee;
            font-size: 1.3rem;
            width: 100%;
            text-align: center;
            padding-top: .6rem;
            padding-bottom:.6rem;
            background: linear-gradient(to bottom, #333, #ccc);
            border-radius: 10px 10px 0px 0px;
        }
        
        #resolve-subheader {          
            font-size: 1rem;
            width: 100%;
            text-align: center;
            color:#fff;
        }
        #resolve-list {
            height:300px;
            overflow:scroll;
            font-size:1.1rem;
            background-color: #eee;
        }
        
        #resolve-list .item {
            color:#111;
            flexFlow:row;
            height:1.3rem;
            padding:.3rem;
            padding-left:.6rem;
            overflow:hidden;
        }

        #resolve-list .item .icon-container img {
            margin-right: .3rem;
            height: 1rem;
            border: solid 1px #cce;
        }

        #resolve-list .item .icon {
            margin-right: .3rem;
            height: 1rem;
            border: solid 1px #cce;
        }
        

        #resolve-list .item .icon.new {
            background-image: url('${chrome.extension.getURL('new.png')}');
            width:1rem;
            height:1rem;
            background-repeat: no-repeat;
            background-size: 1rem;
            border:0px;

        }
        
        #resolve-list .item:hover .icon.new{
            background-image: url('${chrome.extension.getURL('new-white.png')}');
        }

        #resolve-list .item:hover {
            background-color:#36a;
            color:#eee;
            cursor: pointer;
            transition: all 0.2s ease-in;
        }

        .intentRow {
            padding-top:.6rem;
            padding-bottom:.6rem;
        }
        
        .intentTitle {
            font-size:.9rem;
            padding-left:.3rem;
            color:#333;
            padding-bottom: .1rem;
            border-bottom:.5px solid #bbb;
            transition: all 0.2s ease-in;
        }
        
        .intentTitle:hover {
            cursor: pointer;
            color: #444;
            transition: all 0.2s ease-in;
        }
        
  

        `;
        const header : HTMLElement = document.createElement('div');
        header.id = "resolve-header";
        const headerText : HTMLElement = document.createElement('span');
        headerText.className = "header-text";
        header.appendChild(headerText);
       

        const subheader : HTMLElement = document.createElement('div');
        subheader.id = "resolve-subheader";
        subheader.textContent = "choose an app";
        header.appendChild(subheader);
        wrapper.appendChild(header);
        
        const list : HTMLElement = document.createElement('div');
        list.id = "resolve-list";
        wrapper.appendChild(list);
        
        // Attach the created elements to the shadow dom
        shadow.appendChild(style);
        shadow.appendChild(wrapper);
        

      
        return root;
    }
  //add click handler to close the resolver
  document.addEventListener("DOMContentLoaded", () => {
    document.addEventListener("click", (event : MouseEvent) => {
        port.postMessage({topic:"resolver-close"});   
        if (resolver){
            resolver.style.display = "none";
        }
    });
  });
 

  //inject the FDC3 API
  const s : Element = document.createElement('script');
  s.setAttribute("src", chrome.extension.getURL('api.js'));

  
  
  (document.head||document.documentElement).appendChild(s);