//psn.js?version=2.7
//requires config.js, main.js, sdl.js

var psn_loadIDs = []; //will hold individual load ids
var psn_trailerIDs = []; //will hold individual trailer ids
var psn_apiJson = []; //will hold an array of load details returned from each api call
var psn_unloadDownstackHours = []; //array of { ttype: "RDC, etc", unloader_count: integer, unload_hours: decimal, downstack_hours: decimal }
var psn_bkpkProcessHours = []; //array of { apparel_hours: decimal, non_apparel_hours: decimal }

//pass in json.shipments.payload
function psn_init(storeNbr, schedDate, source, shipments, moved, sdl)
{
	var payload = null;
	psn_unloadDownstackHours = [];
	psn_bkpkProcessHours = [];

	if (!shipments || (shipments.errors && shipments.errors.length > 0))
	{
		if (sdl.length == 0)
		{
			main_apiDetailsFinished();
			return; //this is probably for a future date with no load details but we still want to show the associate schedule
		}
	}
	else
		payload = (source == "sfd") ? shipments.data.trailers.payload : shipments.payload;

	if (!payload)
	{
		if (sdl.length == 0)
		{
			main_apiDetailsFinished();
			return; //this is probably for a future date with no load details but we still want to show the associate schedule
		}
	}

	psn_loadIDs = [];
	psn_trailerIDs = [];

	if (payload)
	{
		//find individual load ids from the shipment api json
		for (var i = 0; i < payload.length; i++)
		{
			if (isNaN(payload[i].transLoadId))
				continue;

			psn_loadIDs.push(payload[i].transLoadId);

			if (payload[i].trailerDetails && payload[i].trailerDetails.carrierTrailerId)
				psn_trailerIDs.push(payload[i].trailerDetails.carrierTrailerId.trim());

		}
	}

	//check for trailers moved to the date
	var testSchedDate = cmn_getDateString("yyyy-mm-dd", schedDate);
	for (var i = 0; i < moved.length; i++)
	{
		var movedToDate = cmn_getDateString("yyyy-mm-dd", moved[i].unload_date);

		if (movedToDate == testSchedDate && psn_loadIDs.includes(String(moved[i].load_id)) == false)
			psn_loadIDs.push(moved[i].load_id);
	}

	//check for trailers that are missing from the api data but are in the db2 data (if db2 data is turned on in web.config)
	for (var i = 0; i < sdl.length; i++)
	{
		if (sdl_checkIfLoadIDExists(sdl[i].load_id) == false)
			psn_loadIDs.push(sdl[i].load_id);
	}

	if (psn_loadIDs.length == 0)
		main_apiDetailsFinished();
	else
	{
		psn_callDetailsAPI(storeNbr, schedDate);

		if (main_json.get_star_freight_from_db2 == true)
			psn_getStarFreightFromDB2(storeNbr);
		else
			ss_set("fpt_starFreight", LZString144.compress("[]"));
	}
}

//if getStarFreightFromDB2 in web.config is yes we'll get the event codes base on psn_loadIDs
function psn_getStarFreightFromDB2(storeNbr)
{
	var alsoGetNonStarFreightEventCodes = main_json.also_get_non_star_freight_event_codes_from_db2;
	var allEventCodesParm = (alsoGetNonStarFreightEventCodes == true) ? "&alsoGetNonStarFreightEventCodes=true" : ""; //pcguy added on 4/15/2026 due to apparel being marked as "HO PUSH" from idocs event though it should've been "POS REPLN"

	var url = "../ashx/StarFreight.ashx?func=getStarFreightFromDB2&storeNbr=" + storeNbr + "&loadIDs=" + psn_loadIDs + allEventCodesParm;
	//window.open(url);

	ajax3_sendRequest({
		url: url,
		func: _callback
	});

	function _callback(json)
	{
		var jsonStr = ajax3_toString(json);
		ss_set("fpt_starFreight", LZString144.compress(jsonStr));
	}
}

//after we have all of the load ids in psn_loadIDs, call this function to get the details
function psn_callDetailsAPI(storeNbr, schedDate)
{
	psn_apiJson = [];

	//if getLoadSummaryAndDetailsFromDB call api, insert to db, and select from there, else if getLoadSummaryAndDetailsFromAPI call api and reformat the json
	var func = (main_json.insert_item_details_into_db == true) ? "getLoadSummaryAndDetailsFromDB" : "getLoadSummaryAndDetailsFromAPI";
	var baseUrl = "../ashx/Shipments.ashx?func=" + func + "&storeNbr=" + storeNbr + "&businessDate=" + schedDate
	var counter = psn_loadIDs.length;

	for (var i = 0; i < psn_loadIDs.length; i++)
	{
		var url = baseUrl + "&loadID=" + psn_loadIDs[i];

		if (psn_trailerIDs[i]) //from the initial scan of SFD, psn_loadIDs and psn_trailerIDs will be 1:1
			url += "&trailerID=" + psn_trailerIDs[i];

		var ttype = sdl_getTrailerType(psn_loadIDs[i]);

		if (ttype == "")
			ttype = main_findTrailerType(psn_loadIDs[i]);

		if (ttype != "")
			url += "&ttype=" + ttype;

		if (main_json.api_for_details_use_stage == true)
			url += "&useStageServer=true";

		var trailerStatus = sdl_getCurrentStatusNoFormat(psn_loadIDs[i]);
		if (trailerStatus.match(/loading/i) || trailerStatus.match(/planned/i) || trailerStatus.match(/pending/i))
		{
			var dcNbr = sdl_getOriginLocID(psn_loadIDs[i]);
			url += "&dcNbr=" + dcNbr + "&useDataSource=DB2"; //TODO: When the PSN API is integrated, pass PSN instead of DB2.
		}
		else if (main_checkUseDB2OverAPIBasedOnTotalCasesEach(psn_loadIDs[i])) //we might just want to filter on ttype == "RDC"
		{
			url += "&useDataSource=DB2";
		}

		if (main_json.debug == true)
			window.open(url);

		ajax3_sendRequest({
			url: url,
			func: _callback
		});
	}

	function _callback(json)
	{
		if (json && ["NOT_FOUND", "UNPROCESSABLE_ENTITY", "OK"].includes(json.status)) //NOT_FOUND is SFD, UNPROCESSABLE_ENTITY is SDS
		{
			psn_apiJson.push(json);
		}

		counter--;

		if (counter <= 0)
		{
			psn_checkBkpkBoxCount();
			psn_showResults(schedDate);
			main_apiDetailsFinished();
		}
	}
}

//the sfd api doesn't return the breakpack box count in the details so we need to add it from the sfd shipment api
function psn_checkBkpkBoxCount()
{
	if (main_json.api_for_shipments_source == "sfd")
	{
		for (var i = 0; i < psn_apiJson.length; i++)
		{
			var loadID = psn_apiJson[i].load_id;

			if (psn_apiJson[i].shipment_summary.length > 0)
				psn_apiJson[i].shipment_summary[0].bkpk_case_count = psn_getCaseCounts(loadID, "BKPK");
		}
	}
}

//after getting the details info from the api calls, show the shipment info to the screen
function psn_showResults(schedDate)
{
	var htm = "";
	var source = main_json.api_for_shipments_source;
	var payload = sdl_getPayloadNode();

	//loop through the shipments api
	for (var i = 0; i < payload.length; i++)
	{
		var loadID = payload[i].transLoadId;
		var trailerID = sdl_getTrailerID(loadID); //(source == "sfd") ? payload[i].trailerDetails.carrierTrailerId : payload[i].trailer.carrierTrailerId;

		if (trailerID == null)
			trailerID = "P-";

		if (main_json.allow_data_from_db2 == true)
			_checkForPalletCountInPSN(i, loadID);

		if (loadID == null || loadID == "undefined" || loadID == "")
			continue;

		if (psn_checkIncludeInPlanOrNot(loadID, schedDate) == false)
			continue;

		var ttype = sdl_formatTrailerType(payload[i].stops[0].commodityTypes[0], null, null);
		if (config_trailerTypesToIgnorePSN.includes(ttype))
			continue;

		var unloadDeets = psn_buildUnloadDetailsTable(i, loadID); //we need to do this regardless if we show it to populate psn_unloadDownstackHours[] and psn_bkpkProcessHours[]

		if (main_json.show_stocking_hours == true)
		{
			htm += ""
				+ "<div class='row pt15'>"
				+ " <div class='col-md-4'>"
				+ " " + psn_buildShipmentDetailsTable(i, loadID, trailerID)
				+ " </div>"
				+ " <div class='col-md-8'>"
				+ "  <br class='d-md-none d-lg-none d-xl-none d-xxl-none'/>"
				+ " " + unloadDeets
				+ " </div>"
				+ "</div>";
		}
		else
		{
			htm += ""
				+ "<div class='row pt15'>"
				+ " <div class='col-md-4'>"
				+ " " + psn_buildShipmentDetailsTable(i, loadID, trailerID)
				+ " </div>"
				+ "</div>";
		}
	}

	//now see if we have trailers added from DB2 that aren't in the shipment api data
	var sdl = main_json.sdl;
	for (var i = 0; i < sdl.length; i++)
	{
		if (sdl_checkIfLoadIDExists(sdl[i].load_id) == true)
			continue;

		var schedTS = sdl[i].sched_delivery_ts;
		var schedDate = cmn_getDateString("mm/dd/yyyy", schedTS);
		var etaTS = sdl[i].est_delivery_ts;
		var arrivalTS = sdl[i].actual_delivery_ts;

		if (psn_checkIncludeInPlanOrNot(sdl[i].load_id, schedDate) == true)
		{
			var addedPsnNode = psn_addTrailerToPlan(sdl[i].shipment_type, sdl[i].load_id, schedDate, schedDate, schedTS, etaTS, arrivalTS, sdl[i].trailer_id, true);
			htm += addedPsnNode;
		}
	}

	//now see if we have added trailers
	var testSchedDate = cmn_getDateString("yyyy-mm-dd", schedDate);
	var moved = main_json.shipments_moved;
	for (var i = 0; i < moved.length; i++)
	{
		var movedToDate = cmn_getDateString("yyyy-mm-dd", moved[i].unload_date);

		if (movedToDate == testSchedDate && sdl_checkIfLoadIDExists(moved[i].load_id) == false)
		{ 
			var schedTS = "";
			var arrivalTS = "";
			var schedDate = moved[i].schedule_date;
			var etaTS = moved[i].eta_date;

			var addedPsnNode = psn_addTrailerToPlan(moved[i].shipment_type, moved[i].load_id, schedDate, schedDate, schedTS, etaTS, arrivalTS, moved[i].trailer_id, true);
			htm += addedPsnNode;
		}
	}

	"divPreShipNotification"._dom().innerHTML = htm;

	//if the logic is turned on in web.config, in some cases we need to get the load details from DB2 but it doesn't have the pallet count
	function _checkForPalletCountInPSN(idx, loadID)
	{
		var payload = sdl_getPayloadNode();

		for (var i = 0; i < psn_apiJson.length; i++)
		{
			//sfd also doesn't return the pallet count as of 11/20/2024
			if (["db2", "sfd"].includes(psn_apiJson[i].data_source) && psn_apiJson[i].load_id == loadID)
			{
				var actual = payload[idx].stops[0].actualShipments;
				var planned = payload[idx].stops[0].plannedShipments;
				var etaType = payload[idx].stops[0].etaType;
				var pallets = sdl_getPalletCount(actual, planned, etaType);

				if (psn_apiJson[i] && psn_apiJson[i].shipment_summary[0])
					psn_apiJson[i].shipment_summary[0].total_pallet_count = pallets;
			}
		}
	}
}

//check main_json.moved for trailers added to the date we are viewing
//if passing in etaTS, arrivalTS, and addedFromDB2=true we'll assume it is DB2 SDL data that is missing in the shipment API
function psn_addTrailerToPlan(ttype, loadID, schedDate, unloadDate, schedTS, etaTS, arrivalTS, trailerID, addedFromDB2)
{
	var htm = "";
	
	var unloadDeets = _buildUnloadDetailsTable(); //we need to do this regardless if we show it to populate psn_unloadDownstackHours[] and psn_bkpkProcessHours[]

	if (main_json.show_stocking_hours == true)
	{
		htm = ""
			+ "<div class='row pt15'>"
			+ " <div class='col-md-4'>"
			+ _buildShipmentDetailsTable()
			+ " </div>"
			+ " <div class='col-md-8'>"
			+ "  <br class='d-md-none d-lg-none d-xl-none d-xxl-none'/>"
			+ unloadDeets
			+ " </div>"
			+ "</div>";
	}
	else
	{
		htm = ""
			+ "<div class='col-md-4'>"
			+ " <br class='d-md-none d-lg-none d-xl-none d-xxl-none'/>"
			+ _buildShipmentDetailsTable()
			+ "</div>";
	}

	return htm;

	//build the shipment details
	function _buildShipmentDetailsTable()
	{
		var headerNotes = "** Trailer Added to Plan **";
		var moveIconHTML = "&nbsp;";

		//if this is true then we are adding data from DB2 that doesn't exist in the schedule API as opposed to adding a moved trailer
		if (addedFromDB2 == true)
		{
			headerNotes = "";

			if (arrivalTS != "")
				headerNotes = "Arrived " + _formatDateTime(arrivalTS);
			else
				headerNotes = "<span class='font13'>ETA <i>(not yet available)</i></span>";

			if (main_json.allow_change_unload_date == true && main_json.read_only == false)
			{
				var btnclick = "psn_changeUnloadDate(" + loadID + ", \"" + cmn_getDateString("m/d/yyyy", schedDate) + "\", \"" + cmn_getDateString("m/d/yyyy", etaTS) + "\", \"" + ttype + "\", \"" + trailerID + "\")";

				moveIconHTML = ""
					+ "<button class='font18 btn btn-link' onclick='" + btnclick + "'>"
					+ " <i class='fa fa-random' data-bs-toggle='popover' data-bs-placement='left' data-bs-trigger='hover' data-bs-content='Change Unload Date'></i>"
					+ "</button>";
			}
		}

		var thead = ""
			+ "<thead>"
			+ " <tr>"
			+ "  <td style='padding:0px' colspan='2'>"
			+ "   <table style='width:100%' class='radius5 bg-200'>"
			+ "    <tr>"
			+ "     <th class='text-start font16'>"
			+ " " + sdl_formatTrailerType(ttype)
			+ "     </th>"
			+ "     <td style='width:56%' class='text-start'>"
			+ "      <span class='font13'>" + headerNotes + "</span>"
			+ "     </td>"
			+ "     <td style='width:10%' class='text-center'>"
			+ " " + moveIconHTML
			+ "     </td>"
			+ "    </tr>"
			+ "   </table>"
			+ "  </td>"
			+ " </tr>"
			+ "</thead>";

		var fullCases = psn_getCaseCounts(loadID, "FULL");
		var bkpkCases = psn_getCaseCounts(loadID, "BKPK");
		var gmCases = psn_getCaseCounts(loadID, "GM");
		var grocCases = psn_getCaseCounts(loadID, "GROC");
		var consCases = psn_getCaseCounts(loadID, "CONS");

		var bkpkAreaHref = "<a href='javascript:psn_showCaseCountsByArea(" + loadID + ", \"BKPK\")'>Area</a>";
		var bkpkDeptHref = "<a href='javascript:psn_showCaseCountsByDept(" + loadID + ", \"BKPK\")'>Dept</a>";

		var gmAreaHref = "<a href='javascript:psn_showCaseCountsByArea(" + loadID + ", \"GM\")'>Area</a>";
		var gmDeptHref = "<a href='javascript:psn_showCaseCountsByDept(" + loadID + ", \"GM\")'>Dept</a>";

		var grocConsAreaHref = "<a href='javascript:psn_showCaseCountsByArea(" + loadID + ", \"Groc/Cons\")'>Area</a>";
		var grocConsDeptHref = "<a href='javascript:psn_showCaseCountsByDept(" + loadID + ", \"Groc/Cons\")'>Dept</a>";

		var bkpkHrefDiv = "<div style='display:inline-block; float:left'>" + bkpkAreaHref + " | " + bkpkDeptHref + "</div>";
		var gmHrefDiv = "<div style='display:inline-block; float:left'>" + gmAreaHref + " | " + gmDeptHref + "</div>";
		var grocConsHrefDiv = "<div style='display:inline-block; float:left'>" + grocConsAreaHref + " | " + grocConsDeptHref + "</div>";

		var loadIDHref = "<a title='Click for Load Details' href='javascript:main_viewLoadDetails(\"" + loadID + "\", \"\", \"" + ttype + "\")'>" + loadID + "</a>";

		var tbody = "<tbody>";

		if (addedFromDB2 == true)
		{
			var schedTime = "";

			if (schedTS != "")
			{
				var dt = new Date(schedTS);
				schedTime = dt.toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true }).toLowerCase();
			}

			tbody += ""
				+ "<tr class='hover-hilight-200'>"
				+ " <th class='text-start bb' style='width:40%'>Deliver By</th>"
				+ " <th class='text-start bb pr5'>"
				+ cmn_getDateString("m/d/yyyy", schedDate)
				+ " <div style='display: inline-block; float: right'>" + schedTime + "</div>"
				+ "</th>"
				+ "</tr>";
		}
		else
		{
			tbody += ""
				+ "<tr class='hover-hilight-200'>"
				+ " <th class='text-start bb' style='width:40%'>Deliver Date</th>"
				+ " <th class='text-end bb pr5'>" + cmn_getDateString("m/d/yyyy", schedDate) + "</th>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <th class='text-start bb' style='width:40%'>Unload Date</th>"
				+ " <th class='text-end bb pr5'>" + cmn_getDateString("m/d/yyyy", unloadDate) + "</th>"
				+ "</tr>"
		}

		tbody += ""
			+ "<tr class='hover-hilight-200'>"
			+ " <th class='text-start bb'>Load ID</th>"
			+ " <th class='text-end bb pr5'>" + loadIDHref + "</th>"
			+ "</tr>";

		if (trailerID)
		{
			var trailerIDHref = "<a class='fw-bold' href='javascript:main_viewInvoiceNumbers(\"" + loadID + "\", \"" + trailerID + "\")'>" + trailerID + "</a>";

			tbody += ""
				+ "<tr class='hover-hilight-200'>"
				+ " <th class='text-start bb'>Trailer ID</th>"
				+ " <th class='text-end bb pr5'>" + trailerIDHref + "</th>"
				+ "</tr>";
		}

		if (bkpkCases > 0)
		{
			tbody += ""
				+ " <tr class='hover-hilight-200'>"
				+ "  <th class='text-start bb'>Breakpack Boxes</th>"
				+ "  <th class='text-end bb pr5'>" + bkpkHrefDiv + " " + bkpkCases + "</th>"
				+ " </tr>";
		}

		if (grocCases > 0 || consCases > 0)
		{
			tbody += ""
				+ " <tr class='hover-hilight-200'>"
				+ "  <th class='text-start bb'>Groc/Cons Cases</th>"
				+ "  <th class='text-end bb pr5'>" + grocConsHrefDiv + " " + (grocCases + consCases)._addCommas() + "</th>"
				+ " </tr>";
		}

		if (gmCases > 0)
		{
			tbody += ""
				+ " <tr class='hover-hilight-200'>"
				+ "  <th class='text-start bb'>GM Cases</th>"
				+ "  <th class='text-end bb pr5'>" + gmHrefDiv + " " + gmCases._addCommas() + "</th>"
				+ " </tr>";
		}

		tbody += ""
			+ " <tr class='hover-hilight-200'>"
			+ "  <th class='text-start radius5-bottom-left'>Total Cases</th>"
			+ "  <th class='text-end pr5 radius5-bottom-right'>" + (fullCases + bkpkCases)._addCommas() + "</th>"
			+ " </tr>"
			+ "</tbody>";

		var tfoot = "";
		if (addedFromDB2 == true)
		{
			tfoot = ""
				+ "<tfoot>"
				+ " <tr>"
				+ "  <td colspan='2' class='bt text-center fst-normal font12 e2e-orange'>"
				+ "   Estimate only. This trailer was added from pre-ship notification."
				+ "  </td>"
				+ " </tr>"
				+ "</tfoot>";
		}

		var table = ""
			+ "<table style='width:100%' class='font14 radius5 brdr-400'>"
			+ tbody
			+ thead
			+ tfoot
			+ "</table>";

		return table;
	}

	//build the unload details for an added trailer
	function _buildUnloadDetailsTable()
	{
		var fastMsg = " <a class='fst-normal' target='_blank' href='https://one.walmart.com/content/dam/us-wire-wm1/documents/work/operations/total_store/automation/fast/fast_help_slides/FAST-Dashboard-Reducing-Unload-Time.pdf'>(<i>F.A.S.T. Unload</i>)</a>";

		if (main_checkFastUnload() == false)
			fastMsg = "";

		var fullCases = psn_getCaseCounts(loadID, "FULL");
		var bkpkCases = psn_getCaseCounts(loadID, "BKPK");
		var totCases = fullCases + bkpkCases;

		//downstack and stocking
		var downstackHours = calc_downstackHours(totCases);
		var totalStockingHours = calc_totalStockingHours(loadID, totCases);

		var apparelSortAndProcessing = calc_apparelBreakpackSortHours(loadID);
		var nonApparelSortAndProcessing = calc_nonApparelBreakpackSortHours(loadID);
		psn_bkpkProcessHours.push({ "apparel_hours": + apparelSortAndProcessing, "non_apparel_hours": nonApparelSortAndProcessing });

		var tbody = "<tbody class='font15'>";

		if (String(ttype).match(/RDC/) && main_isStoreLargeFormat() == true)
		{
			var unloadCount = calc_unloaderCount(totCases);
			var unloadTime = calc_unloadTime(totCases, unloadCount);
			psn_unloadDownstackHours.push({ "ttype": ttype, "unloader_count": unloadCount, "unload_hours": unloadTime, "downstack_hours": 0 });

			tbody += ""
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How many associates should you use to unload this trailer?" + fastMsg
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em'>"
				+ "  " + unloadCount
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How long should it take for the unload with this team? (H:MM)"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + unloadTime.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(unloadTime)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How long should it take to complete the GM/Groc/Cons breakpack sort? (H:MM) <sup>1</sup> <sup>2</sup> <sup>3</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + nonApparelSortAndProcessing.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(nonApparelSortAndProcessing)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How long should it take to complete the apparel sort & processing? (H:MM) <sup>1</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + apparelSortAndProcessing.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(apparelSortAndProcessing)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  Estimated total time to stock this trailer (HH:MM) <sup>1</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + totalStockingHours.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(totalStockingHours)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td colspan='2' class='fst-italic font13'>"
				+ "  <sup>1</sup> Hours indicated are for 1 Associate.<br/>"
				+ "  <sup>2</sup> The breakpack sort should begin as soon as the available breakpack boxes have been unloaded from the trailer.<br/>"
				+ "  <sup>3</sup> Please note the times provided for the breakpack sort will vary based on the type of breakpack items and apparel type.<br/>"
				+ " </td>"
				+ "</tr>";
		}
		else
		{
			psn_unloadDownstackHours.push({ "ttype": ttype, "unloader_count": 0, "unload_hours": 0, "downstack_hours": downstackHours });

			tbody += ""
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How many labor hours will it take to downstack this trailer? (H:MM) <sup>1</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + downstackHours.toFixed(2) + "'>"
				+ " " + main_decToHHMM(downstackHours)
				+ " </td>"
				+ "</tr>";

			if (nonApparelSortAndProcessing > 0)
			{
				tbody += ""
					+ "<tr class='hover-hilight-200'>"
					+ " <td class='bb-200 text-start'>"
					+ "  How long should it take to complete the GM/Groc/Cons breakpack sort? (H:MM) <sup>1</sup> <sup>2</sup> <sup>3</sup>"
					+ " </td>"
					+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + nonApparelSortAndProcessing.toFixed(2) + "'>"
					+ "  " + main_decToHHMM(nonApparelSortAndProcessing)
					+ " </td>"
					+ "</tr>";
			}

			if (apparelSortAndProcessing > 0)
			{
				tbody += ""
					+ "<tr class='hover-hilight-200'>"
					+ " <td class='bb-200 text-start'>"
					+ "  How long should it take to complete the apparel sort & processing? (H:MM) <sup>1</sup>"
					+ " </td>"
					+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + apparelSortAndProcessing.toFixed(2) + "'>"
					+ "  " + main_decToHHMM(apparelSortAndProcessing)
					+ " </td>"
					+ "</tr>";
			}

			tbody += ""
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  Estimated total time to stock this trailer (HH:MM) <sup>1</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + totalStockingHours.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(totalStockingHours)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td colspan='2' class='fst-italic font13'>"
				+ "  <sup>1</sup> Hours indicated are for 1 Associate.";

			if (nonApparelSortAndProcessing > 0 || apparelSortAndProcessing > 0)
			{
				tbody += "<br/>"
					+ "  <sup>2</sup> The breakpack sort should begin as soon as the available breakpack boxes have been unloaded from the trailer.<br/>"
					+ "  <sup>3</sup> Please note the times provided for the breakpack sort will vary based on the type of breakpack items and apparel type.<br/>";
			}

			tbody += ""
				+ " </td>"
				+ "</tr>";
		}

		tbody += "</tbody>";

		var table = ""
			+ "<table style='width:100%' class='font14 radius5 brdr-400'>"
			+ tbody
			+ "</table>";

		return table;
	}

	//format date/time similar to the data from the psn api
	function _formatDateTime(ts)
	{
		var dt = new Date(ts);
		var dateStr = dt.toLocaleDateString();
		var timeStr = dt.toLocaleTimeString().replace(/:\d\d\s/, " ").toLowerCase();
		return "<span class='e2e-green2 fw-bold font12'>" + timeStr + "</span> <span class='font13'>" + dateStr + "</span>";
	}
}

//check if this load id should be in the plan or not
function psn_checkIncludeInPlanOrNot(loadIDToCheck, dateToCheck)
{
	//check our moved trailers json array
	var moved = main_json.shipments_moved;
	for (var i = 0; i < moved.length; i++)
	{
		var loadID = moved[i].load_id;
		var schedDate = moved[i].schedule_date;
		var unloadDate = moved[i].unload_date;

		if (loadIDToCheck == loadID)
		{
			if (unloadDate == "")
				return false; //this trailer has been removed from all plans (i.e. it was never actually delivered)

			if (cmn_getDateString("yyyy-mm-dd", unloadDate) != cmn_getDateString("yyyy-mm-dd", dateToCheck))
				return false;
			else
				return true;
		}
	}

	//if we get to this point, check pull-aheads
	var source = main_json.api_for_shipments_source;
	var payload = sdl_getPayloadNode();

	for (var i = 0; i < payload.length; i++)
	{
		if (payload[i].transLoadId == loadIDToCheck) // && payload[i].stops[0].commodityTypes[0] == "RDC")
		{
			if (payload[i].loadStatus == "Tender Canceled")
				return false; //Added 5/18/2025 - SFD was (is) showing canceled loads in the data feed now

			//get deliver by text
			var tz = payload[i].stops[0].stopLocationTimeZone;
			var deliverBy = main_getUTCDateObject(payload[i].stops[0].inductWindowEndTs);

			if (deliverBy != null)
			{
				var deliverByDt = deliverBy.toLocaleDateString('en-US', { timeZone: tz });

				if (cmn_getDateString("yyyy-mm-dd", deliverByDt) != cmn_getDateString("yyyy-mm-dd", dateToCheck))
					return false;
			}
			else if (payload[i].stops[0].actualShipments && payload[i].stops[0].actualShipments.length > 0)
			{
				//if deliverBy is null and caseQuantity is null, this is probably an "internalized parcel" trailer, or ODOT

				if (source == "sfd" && payload[i].stops[0].actualShipments[0].caseQuantity == null)
					return false; 
				
				if (source == "sds" && typeof payload[i].stops[0].actualShipments[0].pckQty != "undefined")
					return false; 
			}
		}
	}

	return true;
}

//build the unload and downstack details
function psn_buildUnloadDetailsTable(idx, loadID)
{
	var source = main_json.api_for_shipments_source;
	var payload = sdl_getPayloadNode();

	//delivery type
	var classification = payload[idx].trailerClassification;
	var classificationReason = payload[idx].trailerClassificationReason;
	var ttype = sdl_formatTrailerType(payload[idx].stops[0].commodityTypes[0], null, null); //just get trailer type with no "pull-ahead" or "overcap" added
	var sdlCases = sdl_getCaseCount(payload[idx].stops[0].actualShipments, payload[idx].stops[0].plannedShipments, payload[idx].stops[0].etaType);
	var psnCases = psn_getCaseCounts(loadID, "TOTAL");
	var totCases = (psnCases > 0) ? psnCases : sdlCases; //sometimes the load details data is not available so we'll use total case count from the shipment api

	var table = ""
		+ "<table style='width:100%' class='font14 radius5 brdr-400'>"
		+ _getTBody(idx, loadID)
		+ "</table>";

	return table;

	//get the table body for the unload calculation section
	function _getTBody(idx, loadID)
	{
		var fastMsg = " <a class='fst-normal' target='_blank' href='https://one.walmart.com/content/dam/us-wire-wm1/documents/work/operations/total_store/automation/fast/fast_help_slides/FAST-Dashboard-Reducing-Unload-Time.pdf'>(F.A.S.T. Unload</i>)</a>";

		if (main_checkFastUnload() == false)
			fastMsg = "";

		//downstack and stocking
		var downstackHours = calc_downstackHours(totCases);
		var totalStockingHours = calc_totalStockingHours(loadID, totCases);
		var disp = (main_json.show_stocking_hours == true) ? "" : "d-none";

		var apparelSortAndProcessing = calc_apparelBreakpackSortHours(loadID);
		var nonApparelSortAndProcessing = calc_nonApparelBreakpackSortHours(loadID);
		psn_bkpkProcessHours.push({ "apparel_hours": + apparelSortAndProcessing, "non_apparel_hours": nonApparelSortAndProcessing });

		var tbody = "<tbody class='font15'>";

		if (ttype.match(/RDC/) && main_isStoreLargeFormat() == true)
		{
			var unloadCount = calc_unloaderCount(totCases);
			var unloadTime = calc_unloadTime(totCases, unloadCount);
			psn_unloadDownstackHours.push({ "ttype": ttype, "unloader_count": unloadCount, "unload_hours": unloadTime, "downstack_hours": 0 });

			tbody += ""
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How many associates should you use to unload this trailer?" + fastMsg
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em'>"
				+ "  " + unloadCount
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How long should it take for the unload with this team? (H:MM)"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + unloadTime.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(unloadTime)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How long should it take to complete the GM/Groc/Cons breakpack sort? (H:MM) <sup>1</sup> <sup>2</sup> <sup>3</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + nonApparelSortAndProcessing.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(nonApparelSortAndProcessing)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How long should it take to complete the apparel sort & processing? (H:MM) <sup>1</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + apparelSortAndProcessing.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(apparelSortAndProcessing)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200 " + disp + "'>"
				+ " <td class='bb-200 text-start'>"
				+ "  Estimated total time to stock this trailer (HH:MM) <sup>1</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + totalStockingHours.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(totalStockingHours)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td colspan='2' class='fst-italic font13'>"
				+ "  <sup>1</sup> Hours indicated are for 1 Associate.<br/>"
				+ "  <sup>2</sup> The breakpack sort should begin as soon as the available breakpack boxes have been unloaded from the trailer.<br/>"
				+ "  <sup>3</sup> Please note the times provided for the breakpack sort will vary based on the type of breakpack items and apparel type.<br/>"
				+ " </td>"
				+ "</tr>";
		}
		else
		{
			psn_unloadDownstackHours.push({ "ttype": ttype, "unloader_count": 0, "unload_hours": 0, "downstack_hours": downstackHours });

			tbody += ""
				+ "<tr class='hover-hilight-200'>"
				+ " <td class='bb-200 text-start'>"
				+ "  How many labor hours will it take to downstack this trailer? (H:MM) <sup>1</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + downstackHours.toFixed(2) + "'>"
				+ " " + main_decToHHMM(downstackHours)
				+ " </td>"
				+ "</tr>";

			if (nonApparelSortAndProcessing > 0)
			{
				tbody += ""
					+ "<tr class='hover-hilight-200'>"
					+ " <td class='bb-200 text-start'>"
					+ "  How long should it take to complete the GM/Groc/Cons breakpack sort? (H:MM) <sup>1</sup> <sup>2</sup> <sup>3</sup>"
					+ " </td>"
					+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + nonApparelSortAndProcessing.toFixed(2) + "'>"
					+ "  " + main_decToHHMM(nonApparelSortAndProcessing)
					+ " </td>"
					+ "</tr>";
			}

			if (apparelSortAndProcessing > 0)
			{
				tbody += ""
					+ "<tr class='hover-hilight-200'>"
					+ " <td class='bb-200 text-start'>"
					+ "  How long should it take to complete the apparel sort & processing? (H:MM) <sup>1</sup>"
					+ " </td>"
					+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + apparelSortAndProcessing.toFixed(2) + "'>"
					+ "  " + main_decToHHMM(apparelSortAndProcessing)
					+ " </td>"
					+ "</tr>";
			}

			tbody += ""
				+ "<tr class='hover-hilight-200 " + disp + "'>"
				+ " <td class='bb-200 text-start'>"
				+ "  Estimated total time to stock this trailer (HH:MM) <sup>1</sup>"
				+ " </td>"
				+ " <td class='bb-200 text-end fw-bold pr3' style='width:7em' title='" + totalStockingHours.toFixed(2) + "'>"
				+ "  " + main_decToHHMM(totalStockingHours)
				+ " </td>"
				+ "</tr>"
				+ "<tr class='hover-hilight-200'>"
				+ " <td colspan='2' class='fst-italic font13'>"
				+ "  <sup>1</sup> Hours indicated are for 1 Associate.";

			if (nonApparelSortAndProcessing > 0 || apparelSortAndProcessing > 0)
			{
				tbody += "<br/>"
					+ "  <sup>2</sup> The breakpack sort should begin as soon as the available breakpack boxes have been unloaded from the trailer.<br/>"
					+ "  <sup>3</sup> Please note the times provided for the breakpack sort will vary based on the type of breakpack items and apparel type.<br/>";
			}

			tbody += ""
				+ " </td>"
				+ "</tr>";
		}

		return tbody + "</tbody>";
	}
}

//build the shipment details of the pre-ship notification section
function psn_buildShipmentDetailsTable(idx, loadID, trailerID)
{
	var source = main_json.api_for_shipments_source;
	var payload = sdl_getPayloadNode();

	var table = ""
		+ "<table style='width:100%' class='font14 radius5 brdr-400'>"
		+ _getTHead(idx, loadID)
		+ _getTBody(idx, loadID)
		+ "</table>";

	return table;

	//get the table body
	function _getTBody(idx, loadID)
	{
		//delivery type
		var classification = payload[idx].trailerClassification;
		var classificationReason = payload[idx].trailerClassificationReason;
		var ttype = sdl_formatTrailerType(payload[idx].stops[0].commodityTypes[0], null, null); //get trailer type without "pull-ahead" or "overcap" appended to it

		//get deliver by text
		var tz = payload[idx].stops[0].stopLocationTimeZone;
		var deliverBy = main_getUTCDateObject(payload[idx].stops[0].inductWindowEndTs);
		var deliverByTxt = "";

		if (deliverBy != null)
		{
			var deliverByDt = deliverBy.toLocaleDateString('en-US', { timeZone: tz });
			var deliverByTm = deliverBy.toLocaleTimeString('en-US', { timeZone: tz }).replace(/:\d\d\s/, " ").toLowerCase();
			deliverByTxt = "<div style='float:left'>" + deliverByDt + "</div> <div style='float:right'>" + deliverByTm + "</div>";
		}

		var routeNbr = (source == "sfd") ? payload[idx].routeNumber : payload[idx].routeNbr;

		trailerID = _checkTxt(trailerID);

		if (trailerID == "-")
			trailerID = "P-";

		var loadIDHref = "<a title='Click for Load Details' href='javascript:main_viewLoadDetails(\"" + loadID + "\", \"" + trailerID + "\", \"" + ttype + "\")'>" + loadID + "</a>";
		var trailerIDHref = "<a class='fw-bold' href='javascript:main_viewInvoiceNumbers(\"" + loadID + "\", \"" + trailerID + "\")'>" + trailerID + "</a>";

		var sdlCases = sdl_getCaseCount(payload[idx].stops[0].actualShipments, payload[idx].stops[0].plannedShipments, payload[idx].stops[0].etaType); //grab this in case our details api returns nothing
		var fullCases = psn_getCaseCounts(loadID, "FULL");
		var bkpkCases = psn_getCaseCounts(loadID, "BKPK");
		var gmCases = psn_getCaseCounts(loadID, "GM");
		var grocCases = psn_getCaseCounts(loadID, "GROC");
		var consCases = psn_getCaseCounts(loadID, "CONS");

		if (fullCases == 0 && sdlCases != "-")
			fullCases = sdlCases;

		if (bkpkCases == 0 && source == "sfd")
			bkpkCases = sdl_checkBreakpackBoxCount(loadID);

		var bkpkAreaHref = "<a href='javascript:psn_showCaseCountsByArea(" + loadID + ", \"BKPK\")'>Area</a>";
		var bkpkDeptHref = "<a href='javascript:psn_showCaseCountsByDept(" + loadID + ", \"BKPK\")'>Dept</a>";

		var gmAreaHref = "<a href='javascript:psn_showCaseCountsByArea(" + loadID + ", \"GM\")'>Area</a>";
		var gmDeptHref = "<a href='javascript:psn_showCaseCountsByDept(" + loadID + ", \"GM\")'>Dept</a>";

		var grocConsAreaHref = "<a href='javascript:psn_showCaseCountsByArea(" + loadID + ", \"Groc/Cons\")'>Area</a>";
		var grocConsDeptHref = "<a href='javascript:psn_showCaseCountsByDept(" + loadID + ", \"Groc/Cons\")'>Dept</a>";

		var bkpkHrefDiv = "<div style='display:inline-block; float:left'>" + bkpkAreaHref + " | " + bkpkDeptHref + "</div>";
		var gmHrefDiv = "<div style='display:inline-block; float:left'>" + gmAreaHref + " | " + gmDeptHref + "</div>";
		var grocConsHrefDiv = "<div style='display:inline-block; float:left'>" + grocConsAreaHref + " | " + grocConsDeptHref + "</div>";

		//check if the details are missing in SDS or SFD or if we had to get the data from DB2
		var caveat = "";

		if (bkpkCases + grocCases + consCases + gmCases == 0) //no details at all
		{
			caveat = ""
				+ "<tr>"
				+ " <td colspan='2' class='bt text-center fst-normal font12 e2e-orange'>"
				+ "  Estimate only. The load details are not yet available in the system."
				+ " </td>"
				+ "</tr>";
		}
		else if (psn_getDataSource(loadID) == "db2")
		{
			caveat = ""
				+ "<tr>"
				+ " <td colspan='2' class='bt text-center fst-normal font12 e2e-orange'>"
				+ "  Estimate only. This trailer was added from pre-ship notification."
				+ " </td>"
				+ "</tr>";
		}

		var tbody = ""
			+ "<tbody>"
			+ " <tr class='hover-hilight-200'>"
			+ "  <th class='text-start bb' style='width:40%'>Deliver By</th>"
			+ "  <th class='text-end bb pr5'>" + deliverByTxt + "</th>"
			+ " </tr>"
			+ " <tr class='hover-hilight-200'>"
			+ "  <th class='text-start bb'>Load ID</th>"
			+ "  <th class='text-end bb pr5'>" + loadIDHref + "</th>"
			+ " </tr>"
			+ " <tr class='hover-hilight-200'>"
			+ "  <th class='text-start bb'>Trailer ID</th>"
			+ "  <th class='text-end bb pr5'>" + trailerIDHref + "</th>"
			+ " </tr>";

			if (routeNbr > 0)
			{
				tbody += ""
					+ " <tr class='hover-hilight-200'>"
					+ "  <th class='text-start bb'>Route Nbr</th>"
					+ "  <th class='text-end bb pr5'>" + routeNbr + "</th>"
					+ " </tr>";
			}

			if (bkpkCases > 0)
			{
				tbody += ""
					+ " <tr class='hover-hilight-200'>"
					+ "  <th class='text-start bb'>Breakpack Boxes</th>"
					+ "  <th class='text-end bb pr5'>" + bkpkHrefDiv + " " + bkpkCases + "</th>"
					+ " </tr>";
			}

			if (grocCases > 0 || consCases > 0)
			{
				tbody += ""
					+ " <tr class='hover-hilight-200'>"
					+ "  <th class='text-start bb'>Groc/Cons Cases</th>"
					+ "  <th class='text-end bb pr5'>" + grocConsHrefDiv + " " + (grocCases + consCases)._addCommas() + "</th>"
					+ " </tr>";
			}

			if (gmCases > 0)
			{
				tbody += ""
					+ " <tr class='hover-hilight-200'>"
					+ "  <th class='text-start bb'>GM Cases</th>"
					+ "  <th class='text-end bb pr5'>" + gmHrefDiv + " " + gmCases._addCommas() + "</th>"
					+ " </tr>";
			}

			tbody += ""
				+ " <tr class='hover-hilight-200'>"
				+ "  <th class='text-start radius5-bottom-left'>Total Cases</th>"
				+ "  <th class='text-end pr5 radius5-bottom-right'>" + (fullCases + bkpkCases)._addCommas() + "</th>"
				+ " </tr>"
				+ caveat
				+ "</tbody>";

		return tbody;
	}

	//get the table header
	function _getTHead(idx, loadID)
	{
		//trailer type
		var ttype = sdl_formatTrailerType(payload[idx].stops[0].commodityTypes[0], null, null); //get trailer type without "pull-ahead" or "overcap" appended to it

		//get delivery by date
		var tz = payload[idx].stops[0].stopLocationTimeZone;
		var deliverBy = main_getUTCDateObject(payload[idx].stops[0].inductWindowEndTs);
		var deliverByDt = (deliverBy == null) ? "" : deliverBy.toLocaleDateString('en-US', { timeZone: tz });

		//delivery type
		var classification = payload[idx].trailerClassification;
		var classificationReason = payload[idx].trailerClassificationReason;
		var ttypeDisplay = sdl_formatTrailerType(payload[idx].stops[0].commodityTypes[0], classification, classificationReason); //get trailer type with classification reason

		//build the eta text
		var tz = payload[idx].stops[0].stopLocationTimeZone;
		var plannedETA = payload[idx].stops[0].arrivalETATs;
		var dynamicETA = payload[idx].stops[0].dynamicArrivalETATs;

		var arrived = "-";
		if (source == "sfd" && payload[idx].stops[0].arrivalStatus && payload[idx].stops[0].arrivalStatus.code && payload[idx].stops[0].arrivalStatus.code == "ARRIVED")
			arrived = sdl_getETA(payload[idx].stops[0].arrivalStatus.ts, null, tz);
		else
			arrived = sdl_getETA(payload[idx].stops[0].actualArrivalTs, null, tz);

		var eta = sdl_getETA(plannedETA, dynamicETA, tz);
		var etaNoFormat = sdl_getETA(plannedETA, dynamicETA, tz, true);
		var etaDate = etaNoFormat.split(" ")[0];

		if (eta == "-")
			eta = "<i>(not yet available)</i>";

		var msg = (arrived == "-") ? "ETA</span> " + eta.replace("<br/>", " ") : "Arrived</span> " + arrived.replace("<br/>", " ");
		var btnclick = "psn_changeUnloadDate(" + loadID + ", \"" + deliverByDt + "\", \"" + etaDate + "\", \"" + ttype + "\", \"" + trailerID + "\")";
		var moveIconHTML = ""
			+ "<button class='font18 btn btn-link' onclick='" + btnclick + "'>"
			+ " <i class='fa fa-random' data-bs-toggle='popover' data-bs-placement='left' data-bs-trigger='hover' data-bs-content='Change Unload Date'></i>"
			+ "</button>";

		if (main_json.read_only == true || main_json.allow_change_unload_date == false)
			moveIconHTML = "&nbsp;";

		var nestedTable = ""
			+ "<table style='width:100%' class='radius5 bg-200'>"
			+ " <tr>"
			+ "  <th class='text-start font16'>"
			+ ttypeDisplay.replace("<br/>", " ")
			+ "  </th>"
			+ "  <td style='width:56%' class='text-start'>"
			+ "   <span class='font13'>" + msg //span will be closed in msg
			+ "  </td>"
			+ "  <td style='width:10%' class='text-center'>"
			+ "   " + moveIconHTML
			+ "  </td>"
			+ " </tr>"
			+ "</table>";

		var thead = ""
			+ "<thead>"
			+ " <tr>"
			+ "  <td style='padding:0px' colspan='2'>"
			+ nestedTable
			+ "  </td>"
			+ " </tr>"
			+ "</thead>";

		return thead;
	}

	//check for null or undefined
	function _checkTxt(txt)
	{
		if (txt == null || txt == "undefined" || txt == "")
			return "-";

		return txt;
	}
}

//change the unload date of a trailer
function psn_changeUnloadDate(loadID, deliverBy, eta, ttype, trailerID)
{
	for (var i = 0; i < main_json.shipments_moved.length; i++)
	{
		if (main_json.shipments_moved[i].load_id == loadID && main_json.shipments_moved[i].unload_date != "")
		{
			var unloadDate = cmn_getDateString("m/d/yyyy", main_json.shipments_moved[i].unload_date);

			var msg = ""
				+ "This trailer was already changed to be unloaded on <span class='e2e-blue1'>" + unloadDate + "</span>. "
				+ "If you need to undo this change, scroll down to \"Trailers Modified from Schedule\" and then click \"Reinstate\"."
				+ "<br/><br/>"
				+ "Delivery Type: <span class='e2e-blue1'>" + sdl_formatTrailerType(ttype) + "</span><br/>"
				+ "Load ID: <span class='e2e-blue1'>" + loadID + "</span><br/>"
				+ "Trailer ID: <span class='e2e-blue1'>" + trailerID + "</span><br/>"
				+ "Deliver By: <span class='e2e-blue1'>" + cmn_getDateString("m/d/yyyy", deliverBy) + "</span><br/>"
				+ "Unload On: <span class='e2e-blue1'>" + unloadDate + "</span>";

			boot5_showModal("Change Unload Date", msg);
			return;
		}
	}

	if (deliverBy == "" || deliverBy.indexOf("NaN") >= 0)
		deliverBy = cmn_getDateString("m/d/yyyy", main_date);

	if (eta == "" || eta.indexOf("NaN") >= 0)
		eta = cmn_getDateString("m/d/yyyy", main_date);

	var dt = new Date(deliverBy);
	var min = cmn_addDays(dt.toString(), -3);
	var max = cmn_addDays(dt.toString(), 5);

	//for ocean freight add more options for unload since they can arrive much later than scheduled delivery date, and ETA is usually not correct
	if (main_json.alignment && main_json.alignment.state_prov_code && ["AK", "HI", "PR"].includes(main_json.alignment.state_prov_code))
	{
		min = cmn_addDays(dt.toString(), -7);
		max = cmn_addDays(dt.toString(), 14);
	}

	var val = cmn_getDateString("yyyy-mm-dd", dt);
	var min = cmn_getDateString("yyyy-mm-dd", min);
	var max = cmn_getDateString("yyyy-mm-dd", max);
	var bkpkBoxes = sdl_checkBreakpackBoxCount(loadID);
	
	var msg = ""
		+ "Delivery Type: <span class='e2e-blue1'>" + sdl_formatTrailerType(ttype) + "</span><br/>"
		+ "Load ID: <span class='e2e-blue1'>" + loadID + "</span><br/>"
		+ "Trailer ID: <span class='e2e-blue1'>" + trailerID + "</span><br/>"
		+ "Deliver By: <span class='e2e-blue1'>" + deliverBy + "</span><br/>"
		+ "ETA Date: <span class='e2e-blue1'>" + eta + "</span><br/>"
		+ "<br/>"
		+ "Set Unload Date: <input type='date' id='inpNewUnloadDate' min='" + min + "' max='" + max + "' value='" + val + "'/>"
		+ "<div class='font11 pt5 e2e-gray5'>If needed, clear the date and then click \"Save\" to completely remove this trailer from all plans.</div>";

	var btnSave = ""
		+ "<img id='imgSaveNewUnloadDate' class='v-hide' src='/Include/img/ajax-loader.gif'/> "
		+ "<button id='btnSaveNewUnloadDate' class='btn btn-dark fw-bold' onclick='psn_saveNewUnloadDate(" + loadID + ", \"" + trailerID + "\", \"" + deliverBy + "\", \"" + eta + "\", \"" + ttype + "\", " + bkpkBoxes + ")'>"
		+ " <div class='pt5'>"
		+ "  Save <i class='fa fa-floppy-o'></i> "
		+ " </div>"
		+ "</button>";

	boot5_showModal("Change Unload Date", msg, "", btnSave);
}

//save the new unload date and then refresh the screen
function psn_saveNewUnloadDate(loadID, trailerID, deliverBy, eta, ttype, bkpkBoxes)
{
	var newUnloadDate = "inpNewUnloadDate"._dom().value;
	var url = "../ashx/NewUnloadDate.ashx?func=insertUnloadDate";
	var tripID = sdl_getTripID(loadID);

	if (tripID == "")
		tripID = "0";

	var parms = ""
		+ "storeNbr=" + main_storeNbr
		+ "&loadID=" + loadID
		+ "&trailerID=" + trailerID
		+ "&tripID=" + tripID
		+ "&deliveryType=" + ttype
		+ "&schedDeliveryDate=" + deliverBy
		+ "&etaDate=" + eta
		+ "&newUnloadDate=" + newUnloadDate
		+ "&bkpkBoxes=" + bkpkBoxes
		+ "&uid=" + login_uid;

	//window.open(url + "&" + parms); return;

	ajax3_sendRequest({
		url: url,
		post: parms,
		btn: "btnSaveNewUnloadDate",
		img: "imgSaveNewUnloadDate",
		func: _callback
	});

	function _callback(json)
	{
		if (!json)
		{
			boot5_updateModalFooter("<span class='e2e-red'>An error occured. Please try again.</span>");
		}
		else
		{
			boot5_closeModal();
			main_search();
		}
	}
}

//get the data source for the psn data: api, api_to_sqlsvr, or db2
function psn_getDataSource(loadID)
{
	for (var i = 0; i < psn_apiJson.length; i++)
	{
		if (psn_apiJson[i].load_id == loadID && psn_apiJson[i].data_source)
			return psn_apiJson[i].data_source;
	}

	return "";
}

//get case counts for GM, GROC, or CONS
function psn_getCaseCounts(loadID, which)
{
	var count = 0;

	//loop through our global array the contains each load
	for (var i = 0; i < psn_apiJson.length; i++)
	{
		if (psn_apiJson[i].load_id != loadID)
			continue;

		if (which == "GM" && psn_apiJson[i].shipment_summary.length > 0)
			count = psn_apiJson[i].shipment_summary[0].gm_cases;

		if (which == "GROC" && psn_apiJson[i].shipment_summary.length > 0)
			count = psn_apiJson[i].shipment_summary[0].groc_cases;

		if (which == "CONS" && psn_apiJson[i].shipment_summary.length > 0)
			count = psn_apiJson[i].shipment_summary[0].cons_cases;

		if (which == "FULL" && psn_apiJson[i].shipment_summary.length > 0)
			count = psn_apiJson[i].shipment_summary[0].full_case_count;

		if (which == "TOTAL" && psn_apiJson[i].shipment_summary.length > 0)
			count = psn_apiJson[i].shipment_summary[0].full_case_count + psn_apiJson[i].shipment_summary[0].bkpk_case_count;

		if (which == "BKPK" && psn_apiJson[i].shipment_summary.length > 0)
			count = psn_apiJson[i].shipment_summary[0].bkpk_case_count;

		break;
	}

	if (isNaN(count))
		count = 0;

	//sfd doesn't have bkpk case counts like sds does so if we have moved a trailer we'll need to check it there
	if (count == 0 && which == "BKPK")
	{
		for (var i = 0; i < main_json.shipments_moved.length; i++)
		{
			if (main_json.shipments_moved[i].load_id == loadID)
				count = main_json.shipments_moved[i].bkpk_case_count;
		}

		if (count == 0)
		{
			var payload = (main_json.shipments.data && main_json.shipments.data.trailers) ? main_json.shipments.data.trailers.payload : [];
			for (var i = 0; i < payload.length; i++)
			{
				if (payload[i].transLoadId == loadID && payload[i].caseSummary)
					count = payload[i].caseSummary.breakPackCount;
			}
		}
	}

	return count;
}

//show case counts by dept for a load id and "GM", "Groc/Cons" or "BKPK"
function psn_showCaseCountsByDept(loadID, gmOrGrocConsOrBkpk)
{
	var bkpkLogic = (gmOrGrocConsOrBkpk == "BKPK") ? true : false;
	var casesOrBkpk = (bkpkLogic == true) ? "Inner Packs" : "Cases";

	var deptArray = [];
	var totalCount = 0;
	var totalStockingTime = 0;

	if (gmOrGrocConsOrBkpk == "GM")
		deptArray = config_deptGM;
	else if (gmOrGrocConsOrBkpk == "Groc/Cons")
		deptArray = config_deptGroc.concat(config_deptCons);
	else
		deptArray = config_deptGM.concat(config_deptGroc, config_deptCons);

	deptArray = deptArray.sort(function(a, b) { return a - b; });
	var disp = (main_json.show_stocking_hours == false) ? "d-none" : "";

	var htm = ""
		+ "<table style='width:100%'>"
		+ " <thead>"
		+ "  <tr>"
		+ "   <th colspan='2'>Department</th>"
		+ "   <th class='text-end'>" + casesOrBkpk + "</th>"
		+ "   <th class='text-end " + disp + "'>Stocking Time <sup>1</sup></th>"
		+ "  </tr>"
		+ " </thead>"
		+ " <tbody>";

	//loop through each department number
	for (var i = 0; i < deptArray.length; i++)
	{
		var counts = calc_getCountsByDept(loadID, deptArray[i]); // [ cases, bkpk ]
		var count = 0;

		if (bkpkLogic == false)
		{
			//full cases
			if (counts[0] == 0)
				continue;

			count = counts[0];
		}
		else
		{
			//inner packs
			if (counts[1] == 0)
				continue;

			count = counts[1];
		}

		var stockingTime = calc_getStockingHoursByDept(count, deptArray[i]);
		totalStockingTime += stockingTime;
		totalCount += count;

		htm += ""
			+ "<tr>"
			+ " <td class='bt-400' style='width:2em'>" + deptArray[i] + "</td>"
			+ " <td class='bt-400'>" + config_getDeptName(deptArray[i]) + "</td>"
			+ " <td class='bt-400 text-end'>" + count._addCommas() + "</td>"
			+ " <td class='bt-400 text-end " + disp + "'>" + main_decToHHMM(stockingTime) + "</td>"
			+ "</tr>";
	}

	htm += ""
		+ " </tbody>"
		+ " <tfoot>"
		+ "  <tr>"
		+ "   <td class='bt-400 fw-bold' colspan='2'>Total</td>"
		+ "   <td class='bt-400 text-end fw-bold'>" + totalCount._addCommas() + "</td>"
		+ "   <td class='bt-400 text-end fw-bold " + disp + "'>" + main_decToHHMM(totalStockingTime) + "</td>"
		+ "  </tr>"
		+ " </tfoot>"
		+ "</table>";

	boot5_showModal("Load Summary by Department", htm, "<i class='" + disp + "'><sup>1</sup> Hours indicated are for one associate as HH:MM.</i>");
}

//show case counts by area for a load id and "GM", "Groc/Cons" or "BKPK"
function psn_showCaseCountsByArea(loadID, gmOrGrocConsOrBkpk)
{
	var bkpkLogic = (gmOrGrocConsOrBkpk == "BKPK") ? true : false;
	var casesOrBkpk = (bkpkLogic == true) ? "Inner Packs" : "Cases";
	var totalStockingTime = 0;
	var totalCount = 0;
	var disp = (main_json.show_stocking_hours == false) ? "d-none" : "";

	var htm = ""
		+ "<table style='width:100%'>"
		+ " <thead>"
		+ "  <tr>"
		+ "   <th>Area</th>"
		+ "   <th class='text-end'>" + casesOrBkpk + "</th>"
		+ "   <th class='text-end " + disp + "'>Stocking Time <sup>1</sup></th>"
		+ "  </tr>"
		+ " </thead>"
		+ " <tbody>";

	for (var i = 0; i < config_storeArea.length; i++)
	{
		if (bkpkLogic == false && config_storeArea[i].rollup_to != gmOrGrocConsOrBkpk)
			continue;

		var areaCount = 0; //the total inner pack or full case count for an area
		var areaStockingTime = 0; //the total stocking time for an area
		var depts = config_storeArea[i].dept_nbrs;
		for (var j = 0; j < depts.length; j++)
		{
			var counts = calc_getCountsByDept(loadID, depts[j]); // [ cases, bkpk ]
			var count = 0;

			if (bkpkLogic == false)
			{
				//full cases
				if (counts[0] == 0)
					continue;

				count = counts[0];
			}
			else
			{
				//inner packs
				if (counts[1] == 0)
					continue;

				count = counts[1];
			}

			var stockingTime = calc_getStockingHoursByDept(count, depts[j]);

			areaStockingTime += stockingTime;
			areaCount += count;

			totalStockingTime += stockingTime;
			totalCount += count;
		}

		if (areaCount > 0)
		{
			htm += ""
				+ "<tr>"
				+ " <td class='bt-400'>" + config_storeArea[i].area_name + "</td>"
				+ " <td class='bt-400 text-end'>" + areaCount._addCommas() + "</td>"
				+ " <td class='bt-400 text-end " + disp + "'>" + main_decToHHMM(areaStockingTime) + "</td>"
				+ "</tr>";
		}
	}

	htm += ""
		+ " </tbody>"
		+ " <tfoot>"
		+ "  <tr>"
		+ "   <td class='bt-400 fw-bold'>Total</td>"
		+ "   <td class='bt-400 text-end fw-bold'>" + totalCount._addCommas() + "</td>"
		+ "   <td class='bt-400 text-end fw-bold " + disp + "'>" + main_decToHHMM(totalStockingTime) + "</td>"
		+ "  </tr>"
		+ " </tfoot>"
		+ "</table>";

	boot5_showModal("Load Summary by Area", htm, "<i class='" + disp + "'><sup>1</sup> Hours indicated are for one associate as HH:MM.</i>");
}

//rollup cases, inner packs, and stocking hours by trailer type
function psn_getTotalCaseCountsByTrailerType(type)
{
	//first get all of the hours for the trailer type
	var results = [];

	for (var i = 0; i < psn_apiJson.length; i++)
	{
		if (psn_apiJson[i].shipment_type != type)
			continue;

		var loadID = psn_apiJson[i].load_id;
		var totalCases = 0; //total cases for this Load
		var totalInnerPacks = 0; //total inner packs for this load

		if (psn_checkIncludeInPlanOrNot(loadID, main_date) == false)
			continue;

		for (var j = 0; j < config_storeArea.length; j++)
		{
			var areaName = config_storeArea[j].area_name;
			var areaCaseCount = 0; //the total full case count for an area
			var areaInnerPackCount = 0; //the total inner pack count for an area
			var areaStockingTime = 0; //the total stocking time for an area

			var depts = config_storeArea[j].dept_nbrs;
			for (var k = 0; k < depts.length; k++)
			{
				var counts = calc_getCountsByDept(loadID, depts[k]); // [ cases, bkpk ]
				var casesStockingTime = calc_getStockingHoursByDept(counts[0], depts[k]);
				var innerPackStockingTime = calc_getStockingHoursByDept(counts[1], depts[k]);

				areaStockingTime += casesStockingTime + innerPackStockingTime;
				areaCaseCount += counts[0];
				areaInnerPackCount += counts[1];

				totalCases += counts[0];
				totalInnerPacks += counts[1];
			}

			if (areaCaseCount > 0 || areaInnerPackCount > 0)
				results.push([ areaName, areaCaseCount, areaInnerPackCount, areaStockingTime ]);
		}

		if (totalCases + totalInnerPacks == 0)
		{
			var cases = sdl_getCaseCountByLoadID(loadID);
			var time = calc_totalStockingHours(loadID, cases);

			if (cases > 0)
				results.push([ "Other", cases, 0, time ]);
		}
	}

	//next condense it
	var results2 = [];
	for (var i = 0; i < config_storeArea.length; i++)
	{
		var areaName = config_storeArea[i].area_name;
		var totalCases = 0;
		var totalInnerPacks = 0;
		var totalStockingHours = 0;

		for (var j = 0; j < results.length; j++)
		{
			if (results[j][0] == areaName)
			{
				totalCases += results[j][1];
				totalInnerPacks += results[j][2];
				totalStockingHours += results[j][3];
			}
		}

		if (totalCases > 0 || totalInnerPacks > 0)
			results2.push([ areaName, totalCases, totalInnerPacks, totalStockingHours ]);
	}

	//now build the html
	var totalCases = 0;
	var totalInnerPacks = 0;
	var totalHours = 0;

	var thead = ""
		+ "<thead>"
		+ " <tr>"
		+ "  <th>Area Name</th>"
		+ "  <th class='text-end'>Cases</th>"
		+ "  <th class='text-end'>Inner Packs</th>"
		+ "  <th class='text-end'>Stocking Time <sup>1</sup></th>"
		+ " </tr>"
		+ "</thead>";

	var tbody = "<tbody>";
	for (var i = 0; i < results2.length; i++)
	{
		totalCases += results2[i][1];
		totalInnerPacks += results2[i][2];
		totalHours += results2[i][3];

		tbody += ""
			+ "<tr>"
			+ " <td class='bt'>" + results2[i][0] + "</td>"
			+ " <td class='bt text-end'>" + cmn_addCommas(results2[i][1]) + "</td>"
			+ " <td class='bt text-end'>" + cmn_addCommas(results2[i][2]) + "</td>"
			+ " <td class='bt text-end'>" + main_decToHHMM(results2[i][3]) + "</td>"
			+ "</tr>";
	}

	tbody += "</tbody>";

	var tfoot = ""
		+ "<tfoot>"
		+ " <tr>"
		+ "  <td class='bt fw-bold'>Total</td>"
		+ "  <td class='bt fw-bold text-end'>" + cmn_addCommas(totalCases) + "</td>"
		+ "  <td class='bt fw-bold text-end'>" + cmn_addCommas(totalInnerPacks) + "</td>"
		+ "  <td class='bt fw-bold text-end'>" + main_decToHHMM(totalHours) + "</td>"
		+ " </tr>"
		+ "</tfoot>";

	var table = ""
		+ "<table style='width:100%'>"
		+ thead
		+ tbody
		+ tfoot
		+ "</table>";

	boot5_showModal(type + " Load Summary by Area", table, "<sup>1</sup> <i>Hours indicated are for one Associate as HH:MM.</i>");
}











